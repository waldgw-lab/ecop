import { useCallback, useEffect, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCorners,
  pointerWithin,
  type CollisionDetection,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Settings2, Columns3, Check, Lock } from "lucide-react";
import type { TickerMode } from "@/components/MarketTicker";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import {
  BOARD_SLOT_IDS,
  SECTIONS,
  SECTION_LABELS,
  BOARD_DEFAULTS,
  SECTION_RULES,
  allowedSlotsFor,
  clampLanesToMode,
  defaultSlotOf,
  normalizeBoard,
  type BoardSlotId,
  type BoardSectionKey,
  type PageMode,
  type SectionRule,
  type BoardLayout,
} from "./curatedBoardLayout";

// Re-export the pure layout rules so existing importers (e.g. Curated.tsx) keep
// resolving these symbols from the board component unchanged.
export {
  SECTION_RULES,
  type BoardSlotId,
  type BoardSectionKey,
  type PageMode,
  type SectionRule,
  type BoardLayout,
};

// -----------------------------------------------------------------------------
// Curated "Configure Layout" drag-and-drop board (Task #322).
//
// This renders the INTERIOR of the Configure Layout dialog as a visual board:
// a full-width HEADER ROW, three columns below (Left split into L1/L2, a tall
// Middle M1, Right split into R1/R2) and a parking tray along the bottom.
// Every Curated section is a draggable card the user can move between slots.
//
// IMPORTANT: The board IS the live layout. Each slot's placements drive WHERE
// every section renders on the Curated page (POSITION) — persisted to
// localStorage and read back by the page. A section's VISIBILITY stays on its
// existing on/off gate (panels = show* flags, feeds = placement !== "off"), and
// the per-card settings (on/off, item counts, Aerial sub-options) are wired
// straight to that state. Guardrails (SECTION_RULES): header items stay in the
// header, Top Stories is locked to the middle (always on), illegal drops snap
// back.
// -----------------------------------------------------------------------------

const ACCENT = "#5FA8C4";

// Option lists mirror the existing Configure Layout selectors.
const AERIAL_MAX_OPTIONS = [3, 5, 10, 15, 20];
const TOP_STORIES_COUNT_OPTIONS = [3, 5, 7, 10];
const STORIES_FEED_COUNT_OPTIONS = [10, 15, 20, 30, 50];


type SocialLayout = 3 | 2 | 1;
type FeedPlacement = "left" | "right" | "off";

// The movable feeds whose live-page column (left / right / off) stays
// configurable from the card.
const FEED_KEYS = new Set<BoardSectionKey>([
  "truth",
  "secwar",
  "osint",
  "press",
  "customFeed",
  "firstAlert",
]);

export interface CuratedLayoutBoardProps {
  // Top bar
  showTicker: boolean;
  setShowTicker: (v: boolean) => void;
  // Market Ticker motion mode (drives the live ticker on the page).
  tickerMode: TickerMode;
  setTickerMode: (v: TickerMode) => void;
  showSearchBar: boolean;
  setShowSearchBar: (v: boolean) => void;
  showMcopBot: boolean;
  setShowMcopBot: (v: boolean) => void;
  // Live leadership broadcast banner — per-viewer on/off. Event-driven header
  // strip with no draggable slot, so its toggle lives in the Header Row group.
  showLiveBanner: boolean;
  setShowLiveBanner: (v: boolean) => void;
  // Restore every section's position, visibility and counts to the factory
  // defaults. The board resets its own placement state; this callback resets the
  // page-level config (visibility/counts/placements + social layout) the parent
  // owns.
  onResetDefaults: () => void;
  // Left column
  showMcopHighlights: boolean;
  setShowMcopHighlights: (v: boolean) => void;
  showIeHighlights: boolean;
  setShowIeHighlights: (v: boolean) => void;
  showAerial: boolean;
  setShowAerial: (v: boolean) => void;
  showAerialDomestic: boolean;
  setShowAerialDomestic: (v: boolean) => void;
  aerialDomesticMax: number;
  setAerialDomesticMax: (v: number) => void;
  showAerialIntl: boolean;
  setShowAerialIntl: (v: boolean) => void;
  aerialIntlMax: number;
  setAerialIntlMax: (v: number) => void;
  showAerialTrending: boolean;
  setShowAerialTrending: (v: boolean) => void;
  // Middle
  showTopStories: boolean;
  setShowTopStories: (v: boolean) => void;
  // State-controlled Narratives section (Task #450).
  showStateNarratives: boolean;
  setShowStateNarratives: (v: boolean) => void;
  showPreviewPane: boolean;
  setShowPreviewPane: (v: boolean) => void;
  topStoriesCount: number;
  setTopStoriesCount: (v: number) => void;
  storiesFeedCount: number;
  setStoriesFeedCount: (v: number) => void;
  // Movable feeds. Each keeps its live-page column placement (left / right /
  // off) reachable from the card, so the existing page behavior stays fully
  // adjustable. The card's on/off toggle flips between "off" and defaultColumn;
  // the card's settings expose the full left / right / off picker.
  feeds: {
    key: Extract<
      BoardSectionKey,
      "truth" | "secwar" | "osint" | "press" | "customFeed" | "firstAlert"
    >;
    placement: FeedPlacement;
    setPlacement: (p: FeedPlacement) => void;
    defaultColumn: "left" | "right";
  }[];
  // Social bloc column layout (drives R1's 3/2/1 gear).
  socialLayout: SocialLayout;
  setSocialLayout: (v: SocialLayout) => void;
  // Per-X-feed "Hide reposts" display filter. Mirrors the same per-feed toggle
  // reachable from each feed's account-filter dropdown so the two surfaces stay
  // in sync (the page owns the state; both surfaces flip it).
  hideRepostsSecwar: boolean;
  setHideRepostsSecwar: (v: boolean) => void;
  hideRepostsOsint: boolean;
  setHideRepostsOsint: (v: boolean) => void;
  hideRepostsPress: boolean;
  setHideRepostsPress: (v: boolean) => void;
  // When true the viewer is an editor; unlock the 100-item Stories feed option.
  isEditor?: boolean;
}

// ----------------------------------------------------------------------------
// Persistent board placement state — the single source of truth for section
// POSITION on the live Curated page. The page reads this back (loadCuratedBoardLayout).
// ----------------------------------------------------------------------------
// V2 introduced the per-sub-column lane model (each slot is an array of lanes
// instead of a flat list); a bumped key discards stale V1 placements so the new
// sub-column defaults apply cleanly.
export const BOARD_LAYOUT_KEY = "curatedBoardLayoutV2";

// Fired on `window` whenever the board persists a new layout, so the live
// Curated page can re-read its R1 lanes immediately (same tab — the native
// `storage` event only fires in OTHER tabs).
export const CURATED_BOARD_LAYOUT_CHANGED_EVENT = "curated-board-layout-changed";



function loadBoard(): BoardLayout {
  try {
    const raw = localStorage.getItem(BOARD_LAYOUT_KEY);
    return normalizeBoard(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeBoard(null);
  }
}

// Adjust a slot's lane list to exactly `count` lanes. Growing pads with empty
// lanes; shrinking merges the overflow lanes' cards into the last kept lane so
// nothing is lost when the user picks fewer columns.
function reshapeLanes(
  lanes: BoardSectionKey[][],
  count: number,
): BoardSectionKey[][] {
  const out = lanes.map((l) => [...l]);
  if (out.length === count) return out;
  if (out.length < count) {
    while (out.length < count) out.push([]);
    return out;
  }
  const kept = out.slice(0, count);
  const overflow = out.slice(count).flat();
  kept[count - 1] = [...kept[count - 1], ...overflow];
  return kept;
}

// Public read API for the live Curated page (Task #322). The page reads every
// slot to drive section POSITION: R1 lanes feed the social bloc, and L1/L2/R2
// drive the left and right columns (see renderColumnSlots).
export function loadCuratedBoardLayout(): BoardLayout {
  return loadBoard();
}

// The R1 social bloc renders exactly `socialLayout` columns: reshapeLanes pads
// with empty lanes when the saved layout has fewer, or merges overflow into the
// last kept lane when it has more, so the page and the board always agree.
export function selectR1Lanes(
  layout: BoardLayout,
  socialLayout: 1 | 2 | 3,
): BoardSectionKey[][] {
  return reshapeLanes(layout.lanes.r1 ?? [[]], socialLayout);
}

// Lane droppable ids encode their slot + lane index, e.g. "r1::2".
function laneIdOf(slot: BoardSlotId, lane: number): string {
  return `${slot}::${lane}`;
}

function parseLaneId(id: string): { slot: BoardSlotId; lane: number } | null {
  const sep = id.indexOf("::");
  if (sep === -1) return null;
  const slot = id.slice(0, sep) as BoardSlotId;
  const lane = Number(id.slice(sep + 2));
  if (!BOARD_SLOT_IDS.includes(slot) || !Number.isInteger(lane)) return null;
  return { slot, lane };
}

function cloneLanes(
  lanes: Record<BoardSlotId, BoardSectionKey[][]>,
): Record<BoardSlotId, BoardSectionKey[][]> {
  const out = {} as Record<BoardSlotId, BoardSectionKey[][]>;
  for (const slot of BOARD_SLOT_IDS) {
    out[slot] = (lanes[slot] ?? [[]]).map((l) => [...l]);
  }
  return out;
}

// ----------------------------------------------------------------------------
// Small reusable rows for the per-card settings (mirror the old Config rows).
// ----------------------------------------------------------------------------
function CardCheck({
  label,
  checked,
  onChange,
  testid,
  indent,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  testid: string;
  indent?: boolean;
}) {
  return (
    <label
      className={`flex items-center gap-2 px-2 py-1 rounded-md cursor-pointer hover-elevate ${indent ? "ml-4" : ""}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-3.5 h-3.5 cursor-pointer accent-curated-accent"
        data-testid={testid}
      />
      <span className="text-xs flex-1 min-w-0 truncate">{label}</span>
    </label>
  );
}

function CardCount({
  label,
  value,
  options,
  onChange,
  testid,
  indent,
}: {
  label: string;
  value: number;
  options: number[];
  onChange: (v: number) => void;
  testid: string;
  indent?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 px-2 py-1 ${indent ? "ml-4" : ""}`}>
      <span className="text-xs flex-1 min-w-0 truncate text-muted-foreground">
        {label}
      </span>
      <Select
        value={String(value)}
        onValueChange={(v) => onChange(parseInt(v, 10))}
      >
        <SelectTrigger className="h-7 w-[64px]" data-testid={testid}>
          <span>{value}</span>
        </SelectTrigger>
        <SelectContent className="curated-surface">
          {options.map((o) => (
            <SelectItem key={o} value={String(o)}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// Returns the inline settings JSX for a given section card (or null when the
// section has no extra settings beyond its on/off toggle).
function cardSettings(
  key: BoardSectionKey,
  p: CuratedLayoutBoardProps,
): React.ReactNode {
  // The three X feeds expose a "Hide reposts" display filter as their only extra
  // setting; it stays in sync with the same toggle in each feed's account-filter
  // dropdown (both flip the page-owned state).
  if (key === "secwar" || key === "osint" || key === "press") {
    const checked =
      key === "secwar"
        ? p.hideRepostsSecwar
        : key === "osint"
          ? p.hideRepostsOsint
          : p.hideRepostsPress;
    const onChange =
      key === "secwar"
        ? p.setHideRepostsSecwar
        : key === "osint"
          ? p.setHideRepostsOsint
          : p.setHideRepostsPress;
    return (
      <CardCheck
        indent
        label="Hide reposts"
        checked={checked}
        onChange={onChange}
        testid={`board-${key}-hide-reposts`}
      />
    );
  }
  // Remaining feeds no longer expose a Left/Right/Off picker — the board's drag
  // controls POSITION, and the card's on/off checkbox toggles VISIBILITY
  // (placement off <-> defaultColumn). They have no extra settings beyond on/off.
  if (FEED_KEYS.has(key)) {
    return null;
  }
  switch (key) {
    case "ticker":
      return (
        <div className="flex flex-col gap-0.5">
          <div className="mb-0.5 px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
            Ticker motion
          </div>
          {TICKER_MODE_OPTIONS.map((o) => {
            const active = p.tickerMode === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => p.setTickerMode(o.value)}
                className={`flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover-elevate ${
                  active ? "ring-1 ring-curated-accent/60 bg-curated-accent/10" : ""
                }`}
                data-testid={`board-ticker-mode-${o.value}`}
              >
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  <Check
                    className={`w-3 h-3 text-curated-accent-strong ${active ? "" : "invisible"}`}
                  />
                  {o.label}
                </span>
                <span className="ml-[18px] text-[11px] text-muted-foreground">
                  {o.hint}
                </span>
              </button>
            );
          })}
        </div>
      );
    case "aerial":
      return (
        <>
          <CardCheck
            indent
            label="U.S. Domestic"
            checked={p.showAerialDomestic}
            onChange={p.setShowAerialDomestic}
            testid="board-aerial-domestic"
          />
          {p.showAerialDomestic && (
            <CardCount
              indent
              label="Total available"
              value={p.aerialDomesticMax}
              options={AERIAL_MAX_OPTIONS}
              onChange={p.setAerialDomesticMax}
              testid="board-aerial-domestic-max"
            />
          )}
          <CardCheck
            indent
            label="International"
            checked={p.showAerialIntl}
            onChange={p.setShowAerialIntl}
            testid="board-aerial-intl"
          />
          {p.showAerialIntl && (
            <CardCount
              indent
              label="Total available"
              value={p.aerialIntlMax}
              options={AERIAL_MAX_OPTIONS}
              onChange={p.setAerialIntlMax}
              testid="board-aerial-intl-max"
            />
          )}
          <CardCheck
            indent
            label="Trending Now"
            checked={p.showAerialTrending}
            onChange={p.setShowAerialTrending}
            testid="board-aerial-trending"
          />
        </>
      );
    case "topStories":
      return (
        <>
          <CardCheck
            indent
            label="Preview Pane"
            checked={p.showPreviewPane}
            onChange={p.setShowPreviewPane}
            testid="board-preview-pane"
          />
          {p.showPreviewPane && (
            <CardCount
              indent
              label="Preview stories"
              value={p.topStoriesCount}
              options={TOP_STORIES_COUNT_OPTIONS}
              onChange={p.setTopStoriesCount}
              testid="board-top-stories-count"
            />
          )}
          <CardCount
            indent
            label="Stories feed"
            value={!p.isEditor && p.storiesFeedCount > 50 ? 50 : p.storiesFeedCount}
            options={p.isEditor ? [...STORIES_FEED_COUNT_OPTIONS, 100] : STORIES_FEED_COUNT_OPTIONS}
            onChange={p.setStoriesFeedCount}
            testid="board-stories-feed-count"
          />
        </>
      );
    default:
      return null;
  }
}

// Resolve a section's on/off state from the props bundle.
function sectionEnabled(key: BoardSectionKey, p: CuratedLayoutBoardProps): boolean {
  switch (key) {
    case "ticker":
      return p.showTicker;
    case "searchBar":
      return p.showSearchBar;
    case "mcopBot":
      return p.showMcopBot;
    case "mcopHighlights":
      return p.showMcopHighlights;
    case "ieHighlights":
      return p.showIeHighlights;
    case "aerial":
      return p.showAerial;
    case "topStories":
      return p.showTopStories;
    case "stateNarratives":
      return p.showStateNarratives;
    default: {
      const f = p.feeds.find((x) => x.key === key);
      return f ? f.placement !== "off" : true;
    }
  }
}

function setSectionEnabled(
  key: BoardSectionKey,
  p: CuratedLayoutBoardProps,
  v: boolean,
) {
  switch (key) {
    case "ticker":
      return p.setShowTicker(v);
    case "searchBar":
      return p.setShowSearchBar(v);
    case "mcopBot":
      return p.setShowMcopBot(v);
    case "mcopHighlights":
      return p.setShowMcopHighlights(v);
    case "ieHighlights":
      return p.setShowIeHighlights(v);
    case "aerial":
      return p.setShowAerial(v);
    case "topStories":
      return p.setShowTopStories(v);
    case "stateNarratives":
      return p.setShowStateNarratives(v);
    default: {
      const f = p.feeds.find((x) => x.key === key);
      if (f) f.setPlacement(v ? f.defaultColumn : "off");
    }
  }
}

// ----------------------------------------------------------------------------
// Draggable section card.
// ----------------------------------------------------------------------------
// Presentational card body shared by the draggable (slot) and static (header)
// variants. The `dragHandle` slot is null for the static header cards.
function SectionCardBody({
  id,
  props,
  overlay,
  narrow,
  horizontal,
  pageMode,
  setNodeRef,
  style,
  dragHandle,
}: {
  id: BoardSectionKey;
  props: CuratedLayoutBoardProps;
  overlay?: boolean;
  // In a multi-column slot each card is too narrow for the label to sit inline
  // beside the controls, so the label drops to its own line below them.
  narrow?: boolean;
  // In the horizontal HEADER ROW, give cards a min width so they read as
  // side-by-side tiles instead of collapsing to their controls.
  horizontal?: boolean;
  // Threaded only so a card can show where it renders in 2-section page mode.
  pageMode?: PageMode;
  setNodeRef?: (node: HTMLElement | null) => void;
  style?: React.CSSProperties;
  dragHandle?: React.ReactNode;
}) {
  // Locked (non-hideable) sections have no on/off toggle and always read as on.
  const canHide = SECTION_RULES[id].canHide;
  const enabled = canHide ? sectionEnabled(id, props) : true;
  const extra = cardSettings(id, props);
  const hasExtra = extra != null;

  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      style={overlay ? undefined : style}
      className={`rounded-md border bg-card/80 ${
        horizontal ? "min-w-[150px]" : ""
      } ${
        overlay ? "shadow-lg shadow-black/50 border-curated-accent" : "border-border"
      }`}
      data-testid={`board-card-${id}`}
    >
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        {dragHandle}
        {canHide ? (
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setSectionEnabled(id, props, e.target.checked)}
            className="w-3.5 h-3.5 cursor-pointer accent-curated-accent shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-curated-accent"
            aria-label={`Toggle ${SECTION_LABELS[id]}`}
            data-testid={`board-toggle-${id}`}
          />
        ) : (
          <Lock
            className="w-3.5 h-3.5 shrink-0 text-muted-foreground"
            aria-label={`${SECTION_LABELS[id]} is always on`}
            data-testid={`board-locked-${id}`}
          />
        )}
        {!narrow && (
          <span
            className={`text-xs font-medium flex-1 min-w-0 truncate ${
              enabled ? "" : "text-muted-foreground line-through"
            }`}
          >
            {SECTION_LABELS[id]}
          </span>
        )}
        {pageMode === "two" && id === "customFeed" && enabled && (
          <span
            className="shrink-0 whitespace-nowrap rounded border border-border px-1 py-0.5 text-[10px] leading-none text-muted-foreground"
            data-testid="board-hint-customfeed"
          >
            → Right Section
          </span>
        )}
        {hasExtra && !overlay && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className={`h-6 w-6 shrink-0 ${narrow ? "ml-auto" : ""}`}
                aria-label={`Settings for ${SECTION_LABELS[id]}`}
                data-testid={`board-expand-${id}`}
              >
                <Settings2 className="w-3.5 h-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="curated-surface w-64 p-1"
              align="end"
              data-testid={`board-settings-${id}`}
            >
              <div className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {SECTION_LABELS[id]}
              </div>
              {extra}
            </PopoverContent>
          </Popover>
        )}
        {hasExtra && overlay && (
          <span
            className={`inline-flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground ${
              narrow ? "ml-auto" : ""
            }`}
          >
            <Settings2 className="w-3.5 h-3.5" />
          </span>
        )}
      </div>
      {narrow && (
        <div className="px-2 pb-1.5 -mt-0.5">
          <span
            className={`block text-xs font-medium leading-tight break-words ${
              enabled ? "" : "text-muted-foreground line-through"
            }`}
          >
            {SECTION_LABELS[id]}
          </span>
        </div>
      )}
    </div>
  );
}

function SectionCard({
  id,
  props,
  overlay,
  narrow,
  horizontal,
  pageMode,
}: {
  id: BoardSectionKey;
  props: CuratedLayoutBoardProps;
  overlay?: boolean;
  narrow?: boolean;
  horizontal?: boolean;
  pageMode?: PageMode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging && !overlay ? 0.4 : 1,
  };

  const dragHandle = (
    <button
      type="button"
      className="shrink-0 text-muted-foreground cursor-grab active:cursor-grabbing touch-none rounded hover-elevate p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-curated-accent"
      aria-label={`Drag ${SECTION_LABELS[id]}`}
      data-testid={`board-drag-${id}`}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="w-4 h-4" />
    </button>
  );

  return (
    <SectionCardBody
      id={id}
      props={props}
      overlay={overlay}
      narrow={narrow}
      horizontal={horizontal}
      pageMode={pageMode}
      setNodeRef={setNodeRef}
      style={style}
      dragHandle={dragHandle}
    />
  );
}

// Ticker motion options surfaced from the ticker card's settings gear. These
// drive the live page ticker (see MarketTicker `mode`).
const TICKER_MODE_OPTIONS: {
  value: TickerMode;
  label: string;
  hint: string;
}[] = [
  { value: "standard", label: "Standard scroll", hint: "Default horizontal speed" },
  { value: "fast", label: "Faster scroll", hint: "Same banner, quicker pace" },
  { value: "fade", label: "Fade (vertical)", hint: "One index at a time, gently fades in/out" },
  { value: "push", label: "Push (vertical)", hint: "Each index pushes the last up and out" },
];

// ----------------------------------------------------------------------------
// 1/2/3-column picker shown beside slot labels.
// ----------------------------------------------------------------------------
function ColPicker({
  value,
  onChange,
  testid,
}: {
  value: 1 | 2 | 3;
  onChange: (v: 1 | 2 | 3) => void;
  testid: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          aria-label="Choose columns"
          data-testid={testid}
        >
          <Columns3 className="w-3.5 h-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="curated-surface w-auto p-1" align="end">
        <div className="flex items-center gap-1">
          {([3, 2, 1] as const).map((n) => (
            <Button
              key={n}
              type="button"
              size="sm"
              variant={value === n ? "default" : "ghost"}
              className={
                value === n ? "bg-curated-accent border border-curated-accent text-white" : ""
              }
              onClick={() => onChange(n)}
              data-testid={`${testid}-${n}`}
            >
              {n} {n === 1 ? "col" : "cols"}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ----------------------------------------------------------------------------
// A single droppable sub-column lane within a slot. Cards stack vertically; a
// multi-column slot renders one Lane per column so a feed can be placed in (and
// dragged between) a specific sub-column.
// ----------------------------------------------------------------------------
function Lane({
  droppableId,
  items,
  props,
  narrow,
  horizontal,
  minHeight,
  pageMode,
}: {
  droppableId: string;
  items: BoardSectionKey[];
  props: CuratedLayoutBoardProps;
  narrow: boolean;
  horizontal?: boolean;
  minHeight: string;
  pageMode?: PageMode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });
  return (
    <SortableContext
      items={items}
      strategy={
        horizontal ? horizontalListSortingStrategy : verticalListSortingStrategy
      }
    >
      <div
        ref={setNodeRef}
        className={`flex ${
          horizontal ? "flex-row flex-wrap items-start" : "flex-col"
        } gap-1.5 content-start rounded-md p-1.5 transition-colors ${
          isOver ? "bg-curated-accent/10 ring-1 ring-curated-accent/50" : ""
        }`}
        style={{ minHeight }}
        data-testid={`board-lane-${droppableId.replace("::", "-")}`}
      >
        {items.map((key) => (
          <SectionCard
            key={key}
            id={key}
            props={props}
            narrow={narrow}
            horizontal={horizontal}
            pageMode={pageMode}
          />
        ))}
        {items.length === 0 && (
          <div className="flex items-center justify-center text-[11px] text-muted-foreground/40 py-3 select-none">
            Drop here
          </div>
        )}
      </div>
    </SortableContext>
  );
}

// ----------------------------------------------------------------------------
// A slot: its label, optional column picker, and one lane per sub-column.
// ----------------------------------------------------------------------------
function Slot({
  id,
  label,
  lanes,
  props,
  minHeight,
  col,
  horizontal,
  pageMode,
}: {
  id: BoardSlotId;
  label: string;
  lanes: BoardSectionKey[][];
  props: CuratedLayoutBoardProps;
  minHeight: string;
  col?: { value: 1 | 2 | 3; onChange: (v: 1 | 2 | 3) => void };
  // Threaded to cards so they can show a render-target hint in 2-section mode.
  pageMode?: PageMode;
  // The HEADER ROW lays its cards out left-to-right instead of stacking.
  horizontal?: boolean;
}) {
  const colCount = col?.value ?? 1;
  const gridCols =
    colCount === 3
      ? "sm:grid-cols-3"
      : colCount === 2
        ? "sm:grid-cols-2"
        : "grid-cols-1";
  // In a 2- or 3-up slot the lanes are too narrow to keep the label inline.
  const narrow = colCount >= 2;

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-center gap-1 pb-1.5 mb-1.5 border-b border-border/70">
        <span
          className="text-sm font-semibold uppercase tracking-wide text-curated-accent-strong"
        >
          {label}
        </span>
        {col && (
          <ColPicker
            value={col.value}
            onChange={col.onChange}
            testid={`board-col-${id}`}
          />
        )}
      </div>
      <div
        className={`grid ${gridCols} gap-1.5 items-start`}
        data-testid={`board-slot-${id}`}
      >
        {lanes.map((laneItems, idx) => (
          <Lane
            key={idx}
            droppableId={laneIdOf(id, idx)}
            items={laneItems}
            props={props}
            narrow={narrow}
            horizontal={horizontal}
            minHeight={minHeight}
            pageMode={pageMode}
          />
        ))}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Read-only projection of where Custom Feed renders in 2-section page mode.
// ----------------------------------------------------------------------------
// Custom Feed's draggable card lives in a left-source slot, but on the page it
// always renders in the RIGHT section when on. This non-draggable chip mirrors
// that so the board's two-section view doesn't mislead. The on/off toggle stays
// on the card itself (which also shows a "→ Right Section" hint in this mode).
function CustomFeedProjection({ props }: { props: CuratedLayoutBoardProps }) {
  const on = sectionEnabled("customFeed", props);
  return (
    <div
      className="mt-3 rounded-md border border-dashed border-border px-2 py-1.5"
      data-testid="board-projection-customfeed"
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className="text-xs font-medium">{SECTION_LABELS.customFeed}</span>
        <span className="text-[11px] text-muted-foreground">
          {on
            ? "renders here when on"
            : "off — toggle it from its card in the Left Section"}
        </span>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Main board.
// ----------------------------------------------------------------------------
export default function CuratedLayoutBoard(props: CuratedLayoutBoardProps) {
  const [layout, setLayout] = useState<BoardLayout>(() => loadBoard());
  const [activeId, setActiveId] = useState<BoardSectionKey | null>(null);

  // Persist placement state whenever it changes (standalone scaffold key).
  useEffect(() => {
    try {
      localStorage.setItem(BOARD_LAYOUT_KEY, JSON.stringify(layout));
      // Notify the live page (same tab) so the R1 social bloc updates instantly.
      window.dispatchEvent(
        new CustomEvent(CURATED_BOARD_LAYOUT_CHANGED_EVENT, { detail: layout }),
      );
    } catch {
      /* private mode / quota — placement just won't persist this session */
    }
  }, [layout]);

  // Each slot's lane count must track its column choice. R1 follows the existing
  // social-layout setting; the rest read layout.cols. Reconcile on mount and
  // whenever a column choice changes (cards from dropped lanes merge up rather
  // than disappear). reshapeLanes is a no-op once the counts already match, so
  // this never loops.
  const colsKey = JSON.stringify(layout.cols);
  useEffect(() => {
    setLayout((prev) => {
      let changed = false;
      const lanes = cloneLanes(prev.lanes);
      for (const slot of BOARD_SLOT_IDS) {
        if (slot === "header") continue;
        const want = slot === "r1" ? props.socialLayout : prev.cols[slot] ?? 1;
        if (lanes[slot].length !== want) {
          lanes[slot] = reshapeLanes(lanes[slot], want);
          changed = true;
        }
      }
      return changed ? { ...prev, lanes } : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.socialLayout, colsKey]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Pointer-precise collision so a dragged card lands in the EXACT sub-column
  // under the cursor. closestCorners alone latches onto whichever lane's corners
  // are nearest, so a short lane (e.g. R1's middle "U.S. X Feed" column, one
  // card) sitting beside a taller one (the right column's stacked OSINT + Press)
  // is hard to target — the card keeps snapping into the tall neighbour. Using
  // the lane the pointer is actually inside makes every sub-column droppable, and
  // dropping onto an occupied lane stacks the cards there. Keyboard dragging has
  // no pointer, so fall back to closestCorners.
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerHits = pointerWithin(args);
    return pointerHits.length > 0 ? pointerHits : closestCorners(args);
  }, []);

  // Locate the lane (slot + index) that holds a card, or the lane a droppable id
  // refers to directly.
  const findLane = (
    id: string,
  ): { slot: BoardSlotId; lane: number } | null => {
    const parsed = parseLaneId(id);
    if (parsed) return parsed;
    for (const slot of BOARD_SLOT_IDS) {
      const slotLanes = layout.lanes[slot] ?? [];
      for (let i = 0; i < slotLanes.length; i++) {
        if (slotLanes[i].includes(id as BoardSectionKey))
          return { slot, lane: i };
      }
    }
    return null;
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as BoardSectionKey);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const activeKey = active.id as BoardSectionKey;
    const overId = over.id as string;
    const from = findLane(activeKey);
    const to = findLane(overId);
    if (!from || !to) return;
    if (from.slot === to.slot && from.lane === to.lane) return;
    // Snap-back: ignore drops onto a slot this section may not occupy (header
    // items stay in the header, Top Stories is locked to the middle, and the
    // movable feeds/panels can't enter the header or the middle).
    if (!allowedSlotsFor(activeKey, layout.pageMode).includes(to.slot)) return;
    setLayout((prev) => {
      const fromLane = prev.lanes[from.slot]?.[from.lane];
      const toLane = prev.lanes[to.slot]?.[to.lane];
      if (!fromLane || !toLane || !fromLane.includes(activeKey)) return prev;
      const overIsLane = parseLaneId(overId) != null;
      const overIndex = toLane.indexOf(overId as BoardSectionKey);
      const newIndex = overIsLane || overIndex < 0 ? toLane.length : overIndex;
      const lanes = cloneLanes(prev.lanes);
      lanes[from.slot][from.lane] = lanes[from.slot][from.lane].filter(
        (k) => k !== activeKey,
      );
      lanes[to.slot][to.lane] = [
        ...toLane.slice(0, newIndex),
        activeKey,
        ...toLane.slice(newIndex),
      ];
      return { ...prev, lanes };
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;
    const activeKey = active.id as BoardSectionKey;
    const overId = over.id as string;
    const from = findLane(activeKey);
    const to = findLane(overId);
    if (!from || !to) return;
    // Cross-lane moves are already applied in handleDragOver; here we only need
    // to settle a reorder within the same lane.
    if (from.slot === to.slot && from.lane === to.lane) {
      const lane = layout.lanes[from.slot][from.lane];
      const oldIndex = lane.indexOf(activeKey);
      const overIsLane = parseLaneId(overId) != null;
      const newIndex = overIsLane
        ? lane.length - 1
        : lane.indexOf(overId as BoardSectionKey);
      if (oldIndex !== newIndex && newIndex >= 0) {
        setLayout((prev) => {
          const lanes = cloneLanes(prev.lanes);
          lanes[from.slot][from.lane] = arrayMove(
            lanes[from.slot][from.lane],
            oldIndex,
            newIndex,
          );
          return { ...prev, lanes };
        });
      }
    }
  };

  const setPageMode = (m: PageMode) =>
    setLayout((prev) => {
      if (prev.pageMode === m) return prev;
      // Re-clamp on a mode switch: social feeds may legally sit in l1/l2 in
      // 2-section mode (wide left pane), but returning to 3-column mode must
      // pull them back out of the narrow left column to their home slot, or a
      // saved 2-section placement would render in the cramped left column.
      const lanes = cloneLanes(prev.lanes);
      clampLanesToMode(lanes, m);
      return { ...prev, pageMode: m, lanes };
    });
  const setLeftCols = (v: 1 | 2) =>
    setLayout((prev) => (prev.leftCols === v ? prev : { ...prev, leftCols: v }));

  // Reset to defaults — two-step confirm so a stray click can't wipe a carefully
  // arranged board. First click arms the button; a second click within a few
  // seconds restores the factory layout (board placements here) and asks the
  // parent to reset the page-level config (visibility/counts/placements +
  // social layout). The arm state auto-disarms after 4s.
  const [resetArmed, setResetArmed] = useState(false);
  useEffect(() => {
    if (!resetArmed) return;
    const t = setTimeout(() => setResetArmed(false), 4000);
    return () => clearTimeout(t);
  }, [resetArmed]);
  const handleReset = () => {
    if (!resetArmed) {
      setResetArmed(true);
      return;
    }
    setResetArmed(false);
    setLayout(normalizeBoard(null));
    props.onResetDefaults();
  };

  const colFor = (slot: BoardSlotId): 1 | 2 | 3 => {
    if (slot === "r1") return props.socialLayout;
    return layout.cols[slot] ?? 1;
  };
  const setColFor = (slot: BoardSlotId) => (v: 1 | 2 | 3) => {
    if (slot === "r1") props.setSocialLayout(v);
    setLayout((prev) => {
      const cols = slot === "r1" ? prev.cols : { ...prev.cols, [slot]: v };
      const lanes = cloneLanes(prev.lanes);
      lanes[slot] = reshapeLanes(lanes[slot], v);
      return { ...prev, cols, lanes };
    });
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex flex-col gap-3">
        {/* PAGE LAYOUT MODE (follow-up #323) — switch the whole live page
            between the classic 3-column board and a 2-section layout. Lives at
            the top of the configurator, just under the dialog title. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border bg-card px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Page Layout
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleReset}
            className="ml-auto"
            data-testid="button-reset-defaults"
          >
            {resetArmed ? "Click again to confirm" : "Reset to defaults"}
          </Button>
          <div
            className="flex items-center gap-1"
            role="group"
            aria-label="Page layout mode"
          >
            {(
              [
                ["three", "3 Columns"],
                ["two", "2 Sections"],
              ] as [PageMode, string][]
            ).map(([mode, label]) => {
              const active = layout.pageMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setPageMode(mode)}
                  className="text-xs rounded-md px-2.5 py-1 border border-border hover-elevate active-elevate-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-curated-accent"
                  style={
                    active
                      ? { background: ACCENT, borderColor: ACCENT, color: "#0b0f12" }
                      : undefined
                  }
                  data-testid={`button-page-mode-${mode}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {layout.pageMode === "two" && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Left sub-columns
              </span>
              <div
                className="flex items-center gap-1"
                role="group"
                aria-label="Left pane sub-columns"
              >
                {([1, 2] as (1 | 2)[]).map((n) => {
                  const active = layout.leftCols === n;
                  return (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setLeftCols(n)}
                      className="text-xs rounded-md px-2.5 py-1 border border-border hover-elevate active-elevate-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-curated-accent"
                      style={
                        active
                          ? { background: ACCENT, borderColor: ACCENT, color: "#0b0f12" }
                          : undefined
                      }
                      data-testid={`button-left-cols-${n}`}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {layout.pageMode === "two" && (
            <p className="basis-full text-xs text-muted-foreground">
              In 2-section mode the page renders two side-by-side panes — a
              narrower left pane (everything except Top Stories and Custom Feed,
              split into the sub-columns chosen above) and a slightly wider right
              pane (Top Stories, always, plus Custom Feed when on). The board
              below is grouped to match.
            </p>
          )}
        </div>

        {/* HEADER ROW — a full-width droppable slot. Its cards (Market Ticker,
            Search Bar, MCOP Bot by default) are draggable like any other card and
            can be moved to/from the columns or the tray. The Live Broadcast
            Banner toggle lives here too: it's an event-driven header strip with
            no draggable slot, so it sits with the rest of the header controls. */}
        <div className="flex flex-col gap-2">
          <Slot
            id="header"
            label="Header Row"
            lanes={layout.lanes.header}
            props={props}
            minHeight="64px"
            horizontal
          />
          <div
            className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2"
            data-testid="row-live-banner-toggle"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">Live Broadcast Banner</p>
              <p className="text-xs text-muted-foreground">
                Shows a header alert when the President, VP, Secretary of State,
                or Secretary of War is about to speak, is live, or just ended.
                Hidden when nothing is happening.
              </p>
            </div>
            <Switch
              checked={props.showLiveBanner}
              onCheckedChange={props.setShowLiveBanner}
              className="data-[state=checked]:bg-curated-accent"
              data-testid="switch-live-banner"
            />
          </div>
        </div>

        {/* PAGE BODY — the board's shape follows the selected page mode so the
            configurator visually matches what the live page will render. Both
            modes share the SAME slot lanes, so switching mode is lossless. */}
        {layout.pageMode === "two" ? (
          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-3">
            {/* LEFT SECTION — everything that lands in the wide left pane: the
                L1/L2/R1/R2 sources, flattened in that order on the page. */}
            <section
              data-testid="board-section-left"
              className="rounded-md border border-border p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 pb-1.5 mb-2 border-b border-border/70">
                <span
                  className="text-sm font-semibold uppercase tracking-wide text-curated-accent-strong"
                >
                  Left Section
                </span>
                <span className="text-[11px] text-muted-foreground">
                  narrower pane · {layout.leftCols} sub-column
                  {layout.leftCols > 1 ? "s" : ""}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground mb-2 leading-snug">
                Everything turned on here fills the left pane, in order: Left top
                → Left bottom → Right top → Right bottom. Top Stories and Custom
                Feed always render in the Right Section. Set the sub-column count
                up top.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Slot
                  id="l1"
                  label="Left top"
                  lanes={layout.lanes.l1}
                  props={props}
                  pageMode={layout.pageMode}
                  minHeight="96px"
                />
                <Slot
                  id="l2"
                  label="Left bottom"
                  lanes={layout.lanes.l2}
                  props={props}
                  pageMode={layout.pageMode}
                  minHeight="96px"
                />
                <Slot
                  id="r1"
                  label="Right top"
                  lanes={layout.lanes.r1}
                  props={props}
                  pageMode={layout.pageMode}
                  minHeight="96px"
                />
                <Slot
                  id="r2"
                  label="Right bottom"
                  lanes={layout.lanes.r2}
                  props={props}
                  pageMode={layout.pageMode}
                  minHeight="96px"
                />
              </div>
            </section>

            {/* RIGHT SECTION — Top Stories (locked here) plus the Custom Feed
                projection. Custom Feed's draggable card lives in a left source;
                the projection mirrors where it actually renders. */}
            <section
              data-testid="board-section-right"
              className="rounded-md border border-border p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 pb-1.5 mb-2 border-b border-border/70">
                <span
                  className="text-sm font-semibold uppercase tracking-wide text-curated-accent-strong"
                >
                  Right Section
                </span>
                <span className="text-[11px] text-muted-foreground">
                  wider pane
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground mb-2 leading-snug">
                Top Stories always renders here. Custom Feed joins it when turned
                on.
              </p>
              <Slot
                id="m1"
                label="Top Stories"
                lanes={layout.lanes.m1}
                props={props}
                minHeight="120px"
              />
              <CustomFeedProjection props={props} />
            </section>
          </div>
        ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* LEFT — L1 over L2 */}
          <div className="flex flex-col gap-3 md:pr-3 md:border-r border-border">
            <Slot
              id="l1"
              label="Left column — top"
              lanes={layout.lanes.l1}
              props={props}
              minHeight="120px"
              col={{ value: colFor("l1"), onChange: setColFor("l1") }}
            />
            <Slot
              id="l2"
              label="Left column — bottom"
              lanes={layout.lanes.l2}
              props={props}
              minHeight="120px"
              col={{ value: colFor("l2"), onChange: setColFor("l2") }}
            />
          </div>

          {/* MIDDLE — tall M1 */}
          <div className="flex flex-col">
            <Slot
              id="m1"
              label="Center column"
              lanes={layout.lanes.m1}
              props={props}
              minHeight="264px"
              col={{ value: colFor("m1"), onChange: setColFor("m1") }}
            />
          </div>

          {/* RIGHT — R1 over R2 */}
          <div className="flex flex-col gap-3 md:pl-3 md:border-l border-border">
            <Slot
              id="r1"
              label="Right column — top"
              lanes={layout.lanes.r1}
              props={props}
              minHeight="120px"
              col={{ value: colFor("r1"), onChange: setColFor("r1") }}
            />
            <Slot
              id="r2"
              label="Right column — bottom"
              lanes={layout.lanes.r2}
              props={props}
              minHeight="120px"
              col={{ value: colFor("r2"), onChange: setColFor("r2") }}
            />
          </div>
        </div>
        )}

        {/* PARKING TRAY */}
        <div className="border-t border-border pt-2">
          <Slot
            id="tray"
            label="Unplaced Sections"
            lanes={layout.lanes.tray}
            props={props}
            minHeight="72px"
            pageMode={layout.pageMode}
            col={{ value: colFor("tray"), onChange: setColFor("tray") }}
          />
        </div>
      </div>

      <DragOverlay>
        {activeId ? (
          <SectionCard id={activeId} props={props} overlay />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
