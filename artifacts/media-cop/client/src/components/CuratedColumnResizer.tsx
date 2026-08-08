import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * Curated column resizer (Task #378 follow-up).
 *
 * Lets a viewer nudge the Curated page's column widths *slightly* by dragging
 * the vertical lines between columns. The adjustment is bounded (see MAX_DELTA /
 * MIN_WEIGHT) so the dense terminal can be personalised without letting any
 * column collapse or dominate.
 *
 * Design notes that keep this low-risk against the fragile Curated layout:
 * - The grid keeps its exact existing JSX/classNames. We only feed it a column
 *   template through a CSS variable that applies at `lg:` only, so the mobile
 *   single-column stack is untouched.
 * - The grid uses `lg:gap-0`, so a track boundary sits exactly at the running
 *   sum of the fr weights ÷ total — no DOM measurement needed to place a handle.
 * - Total width is conserved: dragging a divider moves weight from one column
 *   to its neighbour, so the other columns never shift.
 */

export const COLUMN_WEIGHTS_KEY = "curatedColumnWeightsV1";

// Bounds that keep the adjustment "slight" and safe.
const MIN_WEIGHT = 0.45; // an fr weight can never drop below this
const MAX_DELTA = 0.6; // a single divider can shift at most this many fr
const KEY_STEP = 0.05; // arrow-key nudge per press (fr)

type WeightsMap = Record<string, number[]>;

function loadWeights(): WeightsMap {
  try {
    const raw = localStorage.getItem(COLUMN_WEIGHTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as WeightsMap;
  } catch {
    /* ignore malformed storage */
  }
  return {};
}

/**
 * Per-viewer store for column-width deltas, keyed by a layout signature (the
 * base fr weights joined). Persisted to localStorage and kept in sync across
 * tabs. Mirrors the persistence pattern used by the Configure Layout board.
 */
export function useCuratedColumnWeights() {
  const [map, setMap] = useState<WeightsMap>(loadWeights);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === COLUMN_WEIGHTS_KEY) setMap(loadWeights());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const update = useCallback((sig: string, deltas: number[]) => {
    setMap((prev) => {
      const next = { ...prev, [sig]: deltas };
      try {
        localStorage.setItem(COLUMN_WEIGHTS_KEY, JSON.stringify(next));
      } catch {
        /* ignore quota / privacy-mode failures */
      }
      return next;
    });
  }, []);

  // Discard every stored per-divider nudge (all layout signatures). Used by the
  // Configure Layout "Reset to Default" so column widths return to the standard
  // fr ratios along with the section placements/visibility.
  const clear = useCallback(() => {
    setMap({});
    try {
      localStorage.removeItem(COLUMN_WEIGHTS_KEY);
    } catch {
      /* ignore quota / privacy-mode failures */
    }
  }, []);

  // Replace the entire weights map (used by the server-sync layer to apply
  // saved column widths when loading prefs from a different device/browser).
  const setAll = useCallback((newMap: WeightsMap) => {
    setMap(newMap);
    try {
      localStorage.setItem(COLUMN_WEIGHTS_KEY, JSON.stringify(newMap));
    } catch {
      /* ignore quota / privacy-mode failures */
    }
  }, []);

  return { map, update, clear, setAll };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Returns a [callbackRef, width] pair. Attach `callbackRef` as the `ref` prop
 * of any element to track its rendered pixel width via ResizeObserver.
 *
 * Uses a callback-ref pattern instead of `useRef + useEffect([ref])` so the
 * observer attaches and detaches correctly whenever the element appears or
 * disappears (e.g. layout-mode switches, conditional rendering).
 */
export function useColumnWidthObserver(): [(el: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(0);
  const roRef = useRef<ResizeObserver | null>(null);

  const callbackRef = useCallback((el: HTMLElement | null) => {
    // Disconnect any observer that was watching the previous element.
    roRef.current?.disconnect();
    roRef.current = null;

    if (!el) {
      setWidth(0);
      return;
    }

    const ro = new ResizeObserver((entries) => {
      setWidth(entries[0].contentRect.width);
    });
    ro.observe(el);
    // Seed synchronously so the step-up check has a value on the first render
    // after mount (before the first ResizeObserver callback fires).
    setWidth(el.getBoundingClientRect().width);
    roRef.current = ro;
  }, []);

  return [callbackRef, width];
}

/** Effective column weights given the base weights and the per-divider deltas. */
export function effectiveWeights(base: number[], deltas: number[]): number[] {
  return base.map((b, i) => {
    const left = deltas[i - 1] ?? 0; // divider on this column's left edge
    const right = deltas[i] ?? 0; // divider on this column's right edge
    return b + right - left;
  });
}

/** Build a `grid-template-columns` string from base weights + deltas. */
export function computeColumnTemplate(base: number[], deltas: number[]): string {
  const eff = effectiveWeights(base, deltas);
  return eff
    .map((w) => `minmax(0, ${Math.max(MIN_WEIGHT, Number(w.toFixed(3)))}fr)`)
    .join(" ");
}

/**
 * The smallest fr-weight a given column may occupy, expressed as the larger of
 * the global MIN_WEIGHT floor and a per-column PIXEL floor (`minPx[i]`) converted
 * to fr against the live container width. The pixel floor is what actually keeps
 * each column wide enough for its header to stay on ONE line — so dragging can
 * never condense a column until its heading (and its trailing controls) wrap to
 * a second line. Because the floor scales with the current container width, it
 * adapts to any screen; because total weight is conserved, honoring it can never
 * cause horizontal overflow (the neighbouring column simply absorbs the space).
 */
function columnMinWeight(
  i: number,
  base: number[],
  total: number,
  minPx: number[],
  containerWidth: number,
): number {
  const px = minPx[i] ?? 0;
  const pxAsFr =
    containerWidth > 0 && px > 0 ? (px / containerWidth) * total : 0;
  return Math.max(MIN_WEIGHT, pxAsFr);
}

/**
 * The largest fr-weight a given column may occupy, expressed from an optional
 * per-column PIXEL ceiling (`maxPx[i]`) converted to fr against the live
 * container width. Returns Infinity when no ceiling is configured (the common
 * case), so it drops out of the divider clamp entirely. The ceiling is what
 * keeps a deliberately-narrow column — e.g. the left rail of single-width
 * sections — from being dragged "super wide" and dominating the grid. Because
 * total weight is conserved, honoring it can never cause horizontal overflow
 * (the neighbouring column simply keeps the space).
 */
function columnMaxWeight(
  i: number,
  base: number[],
  total: number,
  maxPx: number[],
  containerWidth: number,
): number {
  const px = maxPx[i] ?? 0;
  if (!(px > 0) || containerWidth <= 0) return Infinity;
  return (px / containerWidth) * total;
}

/**
 * Clamp a proposed value for divider `j` so neither adjacent column drops below
 * its minimum (see columnMinWeight) and the divider itself never travels more
 * than MAX_DELTA.
 */
function clampDelta(
  j: number,
  base: number[],
  deltas: number[],
  proposed: number,
  minPx: number[],
  maxPx: number[],
  containerWidth: number,
): number {
  const total = base.reduce((a, b) => a + b, 0);
  const prev = deltas[j - 1] ?? 0;
  const next = deltas[j + 1] ?? 0;
  const minL = columnMinWeight(j, base, total, minPx, containerWidth);
  const minR = columnMinWeight(j + 1, base, total, minPx, containerWidth);
  // Optional per-column PIXEL ceilings (Infinity when unset — see columnMaxWeight).
  const maxL = columnMaxWeight(j, base, total, maxPx, containerWidth);
  const maxR = columnMaxWeight(j + 1, base, total, maxPx, containerWidth);
  // w_j    = base[j]   + proposed - prev  must stay in [minL, maxL]
  // w_{j+1}= base[j+1] + next     - proposed must stay in [minR, maxR]
  const lo = Math.max(-MAX_DELTA, minL - base[j] + prev, base[j + 1] + next - maxR);
  const hi = Math.min(MAX_DELTA, base[j + 1] + next - minR, maxL - base[j] + prev);
  // On a very narrow container the minima may be unsatisfiable (lo > hi); in
  // that case clamp() collapses to `hi`, i.e. no further shrink is allowed.
  return clamp(proposed, lo, hi);
}

interface ColumnResizeHandlesProps {
  containerRef: RefObject<HTMLElement>;
  baseWeights: number[];
  deltas: number[];
  onChange: (deltas: number[]) => void;
  // Per-column MINIMUM PIXEL widths (aligned to baseWeights). A column can never
  // be dragged narrower than its entry, so its heading stays on one line. When
  // omitted, only the global MIN_WEIGHT fr floor applies (legacy behaviour).
  minPx?: number[];
  // Per-column MAXIMUM PIXEL widths (aligned to baseWeights). A column can never
  // be dragged wider than its entry, so a deliberately-narrow rail can't be
  // dragged "super wide". Use 0 (or omit an entry) for "no ceiling".
  maxPx?: number[];
}

/**
 * Renders one draggable handle per interior column boundary. Absolutely
 * positioned over the grid (which must be `position: relative`), shown only at
 * `lg` where the multi-column layout exists.
 */
export function ColumnResizeHandles({
  containerRef,
  baseWeights,
  deltas,
  onChange,
  minPx = [],
  maxPx = [],
}: ColumnResizeHandlesProps) {
  const dragRef = useRef<{
    j: number;
    startX: number;
    width: number;
    startDeltas: number[];
  } | null>(null);

  if (baseWeights.length < 2) return null;

  const total = baseWeights.reduce((a, b) => a + b, 0);
  const eff = effectiveWeights(baseWeights, deltas);

  // Live container width — the per-column pixel minimums are enforced against
  // this so the floor tracks the current screen size.
  const measureWidth = () =>
    containerRef.current?.getBoundingClientRect().width ?? 0;

  const applyDelta = (
    j: number,
    proposed: number,
    startDeltas: number[],
    containerWidth: number,
  ) => {
    const nd = [...startDeltas];
    while (nd.length < baseWeights.length - 1) nd.push(0);
    nd[j] = clampDelta(j, baseWeights, startDeltas, proposed, minPx, maxPx, containerWidth);
    onChange(nd);
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.width === 0) return;
    const dxFrac = (e.clientX - d.startX) / d.width;
    const proposed = (d.startDeltas[d.j] ?? 0) + dxFrac * total;
    applyDelta(d.j, proposed, d.startDeltas, d.width);
  };

  const endDrag = () => {
    dragRef.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endDrag);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  };

  // Running boundary position (fraction of total width) after each column.
  let acc = 0;
  return (
    <>
      {baseWeights.slice(0, -1).map((_, j) => {
        acc += eff[j];
        const leftPct = (acc / total) * 100;
        const delta = deltas[j] ?? 0;
        return (
          <div
            key={j}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize columns — drag, or use the left and right arrow keys"
            aria-valuemin={-Math.round(MAX_DELTA * 100)}
            aria-valuemax={Math.round(MAX_DELTA * 100)}
            aria-valuenow={Math.round(delta * 100)}
            tabIndex={0}
            data-testid={`column-resizer-${j}`}
            className="group absolute top-0 bottom-0 z-20 hidden lg:block -translate-x-1/2 w-4 cursor-col-resize touch-none focus:outline-none"
            style={{ left: `${leftPct}%` }}
            onPointerDown={(e) => {
              if (!containerRef.current) return;
              e.preventDefault();
              const rect = containerRef.current.getBoundingClientRect();
              dragRef.current = {
                j,
                startX: e.clientX,
                width: rect.width,
                startDeltas: [...deltas],
              };
              document.body.style.userSelect = "none";
              document.body.style.cursor = "col-resize";
              window.addEventListener("pointermove", onPointerMove);
              window.addEventListener("pointerup", endDrag);
            }}
            onDoubleClick={() => applyDelta(j, 0, deltas, measureWidth())}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                applyDelta(j, (deltas[j] ?? 0) - KEY_STEP, deltas, measureWidth());
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                applyDelta(j, (deltas[j] ?? 0) + KEY_STEP, deltas, measureWidth());
              } else if (e.key === "Home" || e.key === "Enter") {
                e.preventDefault();
                applyDelta(j, 0, deltas, measureWidth());
              }
            }}
          >
            {/* Visible hairline that sits on the existing column border. It
                stays subtle until hover/focus so the dense layout isn't noisy. */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-transparent transition-colors group-hover:bg-[#5FA8C4] group-focus-visible:bg-[#5FA8C4] group-focus-visible:w-0.5"
            />
          </div>
        );
      })}
    </>
  );
}
