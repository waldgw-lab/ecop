/**
 * CuratedNudge — dismissible "Check out MCOP 3.0: Curated View" promo shown on the
 * Classic (/) and Visual (/stream) feeds. Self-contained and client-only.
 *
 * TO RETIRE THIS FEATURE (clean removal — ~5 lines across 3 files):
 *   1. Delete this file (client/src/components/CuratedNudge.tsx).
 *   2. client/src/pages/Dashboard.tsx — remove the `import CuratedNudge` line
 *      and the `<CuratedNudge />` mount.
 *   3. client/src/pages/Stream.tsx — remove the same two lines.
 *
 * There are NO backend, schema, route, or dependency changes to undo.
 * Do NOT remove /api/auth/curated-access — this only reads it; it is shared
 * by Header/Team/Curated/Archive. Leftover browser-storage flags
 * (mcop.curatedNudge*.v1) are harmless residue and can be ignored.
 */
import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { X, Sparkles, ArrowRight } from "lucide-react";

const ACCENT = "#5FA8C4";
const PERSISTENT_DISMISS_KEY = "mcop.curatedNudgeDismissed.v1";
const SESSION_DISMISS_KEY = "mcop.curatedNudgeSessionDismissed.v1";
// Classic (Dashboard) uses "link-curated"; Visual (Stream) overrides it to
// "stream-link-curated". Match either so the callout anchors on both views.
const CURATED_BUTTON_SELECTOR =
  '[data-testid="link-curated"],[data-testid="stream-link-curated"]';
const CARD_WIDTH = 310;
// Below this viewport width the header button can't be reliably located or
// pointed at (it collapses into menus on mobile), so the nudge shows as a
// simple bottom-centered popup instead of an anchored callout.
const MOBILE_MAX_WIDTH = 640;

function readDismissed(): boolean {
  try {
    return localStorage.getItem(PERSISTENT_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    localStorage.setItem(PERSISTENT_DISMISS_KEY, "1");
  } catch {}
}

function readSessionDismissed(): boolean {
  try {
    return sessionStorage.getItem(SESSION_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSessionDismissed() {
  try {
    sessionStorage.setItem(SESSION_DISMISS_KEY, "1");
  } catch {}
}

function readIsMobile(): boolean {
  try {
    return window.innerWidth < MOBILE_MAX_WIDTH;
  } catch {
    return false;
  }
}

interface NudgePosition {
  top: number;
  left: number;
  arrowLeft: number;
}

export default function CuratedNudge() {
  const [, navigate] = useLocation();

  const { data: curatedAccess } = useQuery<{ hasCuratedAccess: boolean }>({
    queryKey: ["/api/auth/curated-access"],
    retry: false,
  });

  const hasCuratedAccess = curatedAccess?.hasCuratedAccess === true;

  const [sessionDismissed, setSessionDismissed] = useState(() => readSessionDismissed());
  const [persistentDismissed] = useState(() => readDismissed());
  const [visible, setVisible] = useState(false);
  const [isMobile, setIsMobile] = useState(() => readIsMobile());
  const [pos, setPos] = useState<NudgePosition | null>(null);
  const [bouncing, setBouncing] = useState(false);
  const bounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const initialDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerBounce = () => {
    setBouncing(false);
    if (bounceTimeoutRef.current) clearTimeout(bounceTimeoutRef.current);
    bounceTimeoutRef.current = setTimeout(() => {
      setBouncing(true);
      bounceTimeoutRef.current = setTimeout(() => {
        setBouncing(false);
      }, 900);
    }, 20);
  };

  // Track viewport size so we can swap between the anchored (desktop) callout
  // and the bottom-centered (mobile) popup.
  useEffect(() => {
    const onResize = () => setIsMobile(readIsMobile());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Reveal after a short delay so it doesn't pop the instant the page loads.
  useEffect(() => {
    if (!hasCuratedAccess || sessionDismissed || persistentDismissed) return;

    initialDelayRef.current = setTimeout(() => {
      setVisible(true);
    }, 3000);

    return () => {
      if (initialDelayRef.current) clearTimeout(initialDelayRef.current);
    };
  }, [hasCuratedAccess, sessionDismissed, persistentDismissed]);

  // Two-bounce on reveal, then every 2 minutes (both layouts).
  useEffect(() => {
    if (!visible) return;

    triggerBounce();
    intervalRef.current = setInterval(() => {
      triggerBounce();
    }, 2 * 60 * 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (bounceTimeoutRef.current) clearTimeout(bounceTimeoutRef.current);
    };
  }, [visible]);

  // Desktop only: anchor the callout beneath the "Curated" switch-view button
  // and keep it pinned there through scroll / resize / layout shifts.
  useEffect(() => {
    if (!visible || isMobile) return;

    const compute = () => {
      const el = document.querySelector(CURATED_BUTTON_SELECTOR);
      if (!el) {
        // Fallback: header button not found — tuck the callout under the
        // top-right corner.
        const left = Math.max(8, window.innerWidth - CARD_WIDTH - 16);
        setPos({ top: 64, left, arrowLeft: CARD_WIDTH - 24 });
        return;
      }
      const r = el.getBoundingClientRect();
      let left = r.right - CARD_WIDTH;
      left = Math.max(8, Math.min(left, window.innerWidth - CARD_WIDTH - 8));
      const top = r.bottom + 10;
      let arrowLeft = (r.left + r.right) / 2 - left;
      arrowLeft = Math.max(16, Math.min(arrowLeft, CARD_WIDTH - 16));
      setPos({ top, left, arrowLeft });
    };

    compute();
    // Retry briefly in case the header hasn't finished laying out yet.
    const retry = setInterval(compute, 300);
    const stopRetry = setTimeout(() => clearInterval(retry), 3000);
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);

    return () => {
      clearInterval(retry);
      clearTimeout(stopRetry);
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [visible, isMobile]);

  const handleDismissSession = (e: React.MouseEvent) => {
    e.stopPropagation();
    writeSessionDismissed();
    setSessionDismissed(true);
  };

  const handleDismissPermanent = (e: React.MouseEvent) => {
    e.stopPropagation();
    writeDismissed();
    setSessionDismissed(true);
  };

  const handleClick = () => {
    navigate("/curated");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  };

  if (!hasCuratedAccess || sessionDismissed || persistentDismissed || !visible) {
    return null;
  }
  // Desktop needs a computed anchor position; mobile does not.
  if (!isMobile && !pos) {
    return null;
  }

  const cardBody = (
    <>
      <div className="h-0.5 w-full rounded-t-md" style={{ backgroundColor: ACCENT }} />

      <button
        className="absolute top-2 right-2 flex items-center justify-center rounded-sm w-6 h-6 text-zinc-400 hover:text-zinc-200 transition-colors"
        style={{ lineHeight: 1 }}
        onClick={handleDismissSession}
        data-testid="curated-nudge-close"
        aria-label="Dismiss"
        tabIndex={0}
      >
        <X className="w-3.5 h-3.5" />
      </button>

      <div className="px-3 pt-3 pb-2.5">
        <div className="flex items-center gap-1.5 mb-1">
          <Sparkles className="w-3 h-3 flex-none" style={{ color: ACCENT }} />
          <span
            className="text-[10px] font-bold uppercase tracking-[0.13em]"
            style={{ color: ACCENT }}
          >
            New
          </span>
        </div>

        <p className="text-[13px] font-semibold text-zinc-100 leading-snug mb-3 whitespace-nowrap">
          Check out MCOP 3.0: Curated View
        </p>

        <div className="flex items-center justify-between">
          <div
            className="flex items-center gap-1 text-[11px] font-semibold"
            style={{ color: ACCENT }}
          >
            Open
            <ArrowRight className="w-3 h-3" />
          </div>
          <button
            className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors underline underline-offset-2"
            onClick={handleDismissPermanent}
            data-testid="curated-nudge-dont-show"
            tabIndex={0}
          >
            Don&apos;t show again
          </button>
        </div>
      </div>
    </>
  );

  const sharedBg = "linear-gradient(135deg, #0f1923 0%, #1a2a38 100%)";
  const sharedBorder = `1px solid rgba(95,168,196,0.35)`;

  // Mobile: simple bottom-centered popup — no header anchoring, no arrow.
  if (isMobile) {
    return (
      <>
        <style>{`
          @keyframes curated-nudge-two-bounce {
            0%, 100% { transform: translateY(0); }
            18% { transform: translateY(-10px); }
            34% { transform: translateY(0); }
            50% { transform: translateY(-5px); }
            64% { transform: translateY(0); }
          }
          .curated-nudge-bounce {
            animation: curated-nudge-two-bounce 0.9s ease-in-out;
          }
        `}</style>

        <div
          className={`fixed z-[9999] rounded-md shadow-2xl cursor-pointer select-none${bouncing ? " curated-nudge-bounce" : ""}`}
          style={{
            bottom: 16,
            left: 12,
            right: 12,
            maxWidth: 400,
            marginLeft: "auto",
            marginRight: "auto",
            background: sharedBg,
            border: sharedBorder,
          }}
          onClick={handleClick}
          data-testid="curated-nudge"
          role="button"
          aria-label="Check out MCOP 3.0: Curated View"
          tabIndex={0}
          onKeyDown={handleKeyDown}
        >
          {cardBody}
        </div>
      </>
    );
  }

  // Desktop: callout anchored beneath the "Curated" switch-view button.
  return (
    <>
      <style>{`
        @keyframes curated-nudge-two-bounce {
          0%, 100% { transform: translateY(0); }
          18% { transform: translateY(-10px); }
          34% { transform: translateY(0); }
          50% { transform: translateY(-5px); }
          64% { transform: translateY(0); }
        }
        .curated-nudge-bounce {
          animation: curated-nudge-two-bounce 0.9s ease-in-out;
        }
      `}</style>

      <div
        className={`fixed z-[9999] rounded-md shadow-2xl cursor-pointer select-none${bouncing ? " curated-nudge-bounce" : ""}`}
        style={{
          top: pos!.top,
          left: pos!.left,
          width: CARD_WIDTH,
          background: sharedBg,
          border: sharedBorder,
        }}
        onClick={handleClick}
        data-testid="curated-nudge"
        role="button"
        aria-label="Check out MCOP 3.0: Curated View"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {/* Pointer arrow aimed up at the Curated button */}
        <div
          className="absolute"
          style={{
            top: -6,
            left: pos!.arrowLeft - 6,
            width: 11,
            height: 11,
            background: "#0f1923",
            borderLeft: `1px solid rgba(95,168,196,0.35)`,
            borderTop: `1px solid rgba(95,168,196,0.35)`,
            transform: "rotate(45deg)",
          }}
        />

        {cardBody}
      </div>
    </>
  );
}
