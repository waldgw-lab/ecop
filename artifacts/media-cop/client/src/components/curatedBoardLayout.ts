// Pure, dependency-free layout rules + normalization for the Curated "Configure
// Layout" board. Extracted from CuratedLayoutBoard.tsx so the guardrail logic
// (placement rules, mode-aware allowed slots, and the normalize/clamp passes)
// can be unit-tested without pulling in React / dnd-kit. The board component
// re-exports the public symbols, so existing importers are unaffected.

export type BoardSlotId =
  | "header"
  | "l1"
  | "l2"
  | "m1"
  | "r1"
  | "r2"
  | "tray";

export const BOARD_SLOT_IDS: BoardSlotId[] = [
  "header",
  "l1",
  "l2",
  "m1",
  "r1",
  "r2",
  "tray",
];

export type BoardSectionKey =
  | "ticker"
  | "searchBar"
  | "mcopBot"
  | "mcopHighlights"
  | "ieHighlights"
  | "aerial"
  | "topStories"
  | "truth"
  | "secwar"
  | "osint"
  | "press"
  | "customFeed"
  | "firstAlert"
  | "stateNarratives";

export const SECTIONS: { key: BoardSectionKey; label: string }[] = [
  { key: "ticker", label: "Market Ticker" },
  { key: "searchBar", label: "Search Bar" },
  { key: "mcopBot", label: "MCOP Bot" },
  { key: "mcopHighlights", label: "MCOP Highlights" },
  { key: "ieHighlights", label: "IE Highlights" },
  { key: "aerial", label: "Aerial View" },
  { key: "topStories", label: "Top Stories" },
  { key: "truth", label: "POTUS Truth Social" },
  { key: "secwar", label: "U.S. X Feed" },
  { key: "osint", label: "OSINT X Feed" },
  { key: "press", label: "Press X Feed" },
  { key: "customFeed", label: "Custom Feed" },
  { key: "firstAlert", label: "DATAMINR" },
  { key: "stateNarratives", label: "State-controlled Narratives" },
];

export const SECTION_LABELS: Record<BoardSectionKey, string> = SECTIONS.reduce(
  (acc, s) => {
    acc[s.key] = s.label;
    return acc;
  },
  {} as Record<BoardSectionKey, string>,
);

// Default arrangement, mirroring the current Curated dashboard. Each slot is an
// array of sub-column "lanes" (see BoardLayout): single-column slots have one
// lane, multi-column slots one lane per column. The tray is empty by default
// because every section is placed.
export const BOARD_DEFAULTS: Record<BoardSlotId, BoardSectionKey[][]> = {
  header: [["ticker", "searchBar", "mcopBot"]],
  l1: [["mcopHighlights", "ieHighlights"]],
  l2: [["aerial", "firstAlert"]],
  m1: [["topStories"]],
  // R1 mirrors the live page's 3-up social bloc: POTUS Truth Social in the left
  // sub-column, U.S. X Feed in the middle, and OSINT + Press stacked in the
  // right (the page rotates those two through the third column).
  r1: [["truth"], ["secwar"], ["osint", "press"]],
  // Custom Feed renders in its own R2 row on the live page, below the bloc;
  // State-controlled Narratives defaults directly beneath it (same R2 lane).
  r2: [["customFeed", "stateNarratives"]],
  tray: [[]],
};

// Whole-page column mode for the live Curated page (follow-up #323). "three" is
// the classic Left / Middle / Right board; "two" collapses the page to a wide
// LEFT pane + a narrow RIGHT pane (Top Stories + Custom Feed).
export type PageMode = "three" | "two";

// Placement rules per section (Task #322 live wiring). `allowedSlots` lists the
// slots a section may legally occupy: a drop anywhere else snaps back
// (handleDragOver) and a saved layout that violates this is clamped in
// normalizeBoard. `required` sections are force-restored to their home slot if a
// stale layout drops them. `canHide` is false for sections with no on/off toggle
// (Top Stories is always on). Header items stay in the header; Top Stories is
// locked to the middle.
export interface SectionRule {
  allowedSlots: BoardSlotId[];
  required?: boolean;
  canHide: boolean;
}

export const SECTION_RULES: Record<BoardSectionKey, SectionRule> = {
  ticker: { allowedSlots: ["header"], canHide: true },
  searchBar: { allowedSlots: ["header"], canHide: true },
  mcopBot: { allowedSlots: ["header"], canHide: true },
  mcopHighlights: { allowedSlots: ["l1", "l2", "r2", "tray"], canHide: true },
  ieHighlights: { allowedSlots: ["l1", "l2", "r2", "tray"], canHide: true },
  aerial: { allowedSlots: ["l1", "l2", "r2", "tray"], canHide: true },
  topStories: { allowedSlots: ["m1"], required: true, canHide: false },
  // Image-heavy social feeds are barred from the narrow three-column LEFT
  // column (l1/l2) — see allowedSlotsFor. They can always live in r1/r2 (the
  // wide social bloc) or the tray. In 2-section page mode l1/l2 roll into the
  // WIDE left pane, so allowedSlotsFor relaxes the bar there (follow-up #506).
  truth: { allowedSlots: ["r1", "r2", "tray"], canHide: true },
  secwar: { allowedSlots: ["r1", "r2", "tray"], canHide: true },
  osint: { allowedSlots: ["r1", "r2", "tray"], canHide: true },
  press: { allowedSlots: ["r1", "r2", "tray"], canHide: true },
  customFeed: { allowedSlots: ["l1", "l2", "r2", "tray"], canHide: true },
  firstAlert: { allowedSlots: ["l1", "l2", "r1", "r2", "tray"], canHide: true },
  stateNarratives: { allowedSlots: ["l1", "l2", "r2", "tray"], canHide: true },
};

// The image-heavy social feeds that are barred from the narrow 3-column left
// column (l1/l2) but may live there in 2-section mode, where l1/l2 render inside
// the wide left pane (follow-up #506).
export const TWO_COL_LEFT_ELIGIBLE_KEYS: ReadonlySet<BoardSectionKey> = new Set<
  BoardSectionKey
>(["truth", "secwar", "osint", "press"]);

// The slots a section may legally occupy in the given page mode. In 3-column
// mode this is exactly SECTION_RULES[key].allowedSlots. In 2-section mode the
// l1/l2 slots roll into the wide left pane, so the social feeds barred from the
// narrow left column may additionally be placed in l1/l2 there.
export function allowedSlotsFor(
  key: BoardSectionKey,
  pageMode: PageMode,
): BoardSlotId[] {
  const base = SECTION_RULES[key].allowedSlots;
  if (pageMode === "two" && TWO_COL_LEFT_ELIGIBLE_KEYS.has(key)) {
    const extra = (["l1", "l2"] as BoardSlotId[]).filter(
      (s) => !base.includes(s),
    );
    if (extra.length) return [...base, ...extra];
  }
  return base;
}

// A section's canonical home slot — where it sits by default — used to clamp an
// illegally-placed section back into a legal slot.
export function defaultSlotOf(key: BoardSectionKey): BoardSlotId {
  for (const slot of BOARD_SLOT_IDS) {
    if (BOARD_DEFAULTS[slot].some((lane) => lane.includes(key))) return slot;
  }
  return SECTION_RULES[key].allowedSlots[0] ?? "tray";
}

// Pull any section out of a slot it may not occupy in the given page mode and
// append it to its canonical home slot's first lane. Mutates `lanes` in place.
// Used both when loading a saved layout (normalizeBoard) and when the user
// switches page mode (so a feed parked in l1/l2 in 2-section mode is clamped
// back out of the narrow left column when returning to 3-column mode).
export function clampLanesToMode(
  lanes: Record<BoardSlotId, BoardSectionKey[][]>,
  pageMode: PageMode,
): void {
  for (const slot of BOARD_SLOT_IDS) {
    for (const lane of lanes[slot]) {
      for (let i = lane.length - 1; i >= 0; i--) {
        const key = lane[i];
        if (!allowedSlotsFor(key, pageMode).includes(slot)) {
          lane.splice(i, 1);
          const home = defaultSlotOf(key);
          if (!lanes[home][0]) lanes[home][0] = [];
          lanes[home][0].push(key);
        }
      }
    }
  }
}

export interface BoardLayout {
  // Each slot is an array of sub-column "lanes". A single-column slot has one
  // lane; a 2-/3-up slot (e.g. R1, the social bloc) has one lane per column so a
  // specific feed can sit in a specific sub-column. The lane count tracks the
  // slot's column choice — see reshapeLanes and the reconcile effect.
  lanes: Record<BoardSlotId, BoardSectionKey[][]>;
  // Internal 1/2/3-column choice per slot. R1 is omitted here because it is
  // bound to the existing social-layout setting.
  cols: Partial<Record<BoardSlotId, 1 | 2 | 3>>;
  // Whole-page column mode (follow-up #323). "three" = the classic Left /
  // Middle / Right layout. "two" renders a wide LEFT pane holding every section
  // except Top Stories + Custom Feed (in `leftCols` sub-columns) and a narrower
  // RIGHT pane holding Top Stories + Custom Feed. Defaults to "three" so an
  // untouched board renders identically to before.
  pageMode: PageMode;
  // Sub-column count for the LEFT pane in 2-column page mode (ignored in
  // three-column mode). Capped at 2 — 3-up is too cramped in that pane.
  leftCols: 1 | 2;
}

export function normalizeBoard(raw: any): BoardLayout {
  const lanes: Record<BoardSlotId, BoardSectionKey[][]> = {
    header: [[]],
    l1: [[]],
    l2: [[]],
    m1: [[]],
    r1: [[]],
    r2: [[]],
    tray: [[]],
  };
  const validKeys = new Set<string>(SECTIONS.map((s) => s.key));
  const seen = new Set<BoardSectionKey>();

  // Accept the V2 lanes shape and (defensively) a legacy flat slots shape — a
  // flat array collapses into a single lane and the reconcile effect respreads.
  const saved = raw?.lanes ?? raw?.slots;
  if (saved) {
    for (const slot of BOARD_SLOT_IDS) {
      const rawSlot = saved[slot];
      const laneArrays: any[][] = Array.isArray(rawSlot)
        ? rawSlot.length > 0 && Array.isArray(rawSlot[0])
          ? (rawSlot as any[][])
          : [rawSlot as any[]]
        : [[]];
      const cleaned: BoardSectionKey[][] = [];
      for (const lane of laneArrays) {
        const out: BoardSectionKey[] = [];
        if (Array.isArray(lane)) {
          for (const k of lane) {
            if (validKeys.has(k) && !seen.has(k)) {
              out.push(k as BoardSectionKey);
              seen.add(k as BoardSectionKey);
            }
          }
        }
        cleaned.push(out);
      }
      lanes[slot] = cleaned.length ? cleaned : [[]];
    }
  } else {
    // No saved layout — start from the defaults.
    for (const slot of BOARD_SLOT_IDS) {
      lanes[slot] = BOARD_DEFAULTS[slot].map((lane) => [...lane]);
      lanes[slot].forEach((lane) => lane.forEach((k) => seen.add(k)));
    }
  }

  // Targeted backfill: State-controlled Narratives is a newer section, so when
  // an existing saved layout predates it we place it directly beneath Custom
  // Feed (its canonical r2 home) rather than dropping it into the tray — without
  // disturbing any of the user's other customizations. If Custom Feed has been
  // moved/hidden, fall back to the r2 default lane so it still lands in r2.
  if (saved && !seen.has("stateNarratives")) {
    let placed = false;
    for (const slot of BOARD_SLOT_IDS) {
      for (const lane of lanes[slot]) {
        const idx = lane.indexOf("customFeed");
        if (idx !== -1) {
          lane.splice(idx + 1, 0, "stateNarratives");
          placed = true;
          break;
        }
      }
      if (placed) break;
    }
    if (!placed) {
      if (!lanes.r2[0]) lanes.r2[0] = [];
      lanes.r2[0].push("stateNarratives");
    }
    seen.add("stateNarratives");
  }

  // Any section not yet placed (new section, or absent from a saved layout)
  // drops into the parking tray's first lane so it is never lost.
  for (const s of SECTIONS) {
    if (!seen.has(s.key)) {
      lanes.tray[0].push(s.key);
      seen.add(s.key);
    }
  }

  const pageMode: PageMode = raw?.pageMode === "two" ? "two" : "three";
  const lc = raw?.leftCols;
  // Clamp any saved leftCols=3 (now-illegal) safely to 2.
  const leftCols: 1 | 2 = lc === 1 ? 1 : 2;

  // Enforce placement rules for the resolved page mode: pull any section out of
  // a slot it is not allowed to occupy (stale save, hand-edited localStorage, a
  // since-removed slot, or a saved 2-section l1/l2 placement now illegal in
  // 3-column mode) and append it to its canonical home slot's first lane.
  clampLanesToMode(lanes, pageMode);

  // Guarantee required sections exist in their home slot even if a saved layout
  // dropped them entirely (Top Stories must always render in the middle).
  for (const s of SECTIONS) {
    if (!SECTION_RULES[s.key].required) continue;
    const present = BOARD_SLOT_IDS.some((slot) =>
      lanes[slot].some((lane) => lane.includes(s.key)),
    );
    if (!present) {
      const home = defaultSlotOf(s.key);
      if (!lanes[home][0]) lanes[home][0] = [];
      lanes[home][0].push(s.key);
    }
  }

  const cols: Partial<Record<BoardSlotId, 1 | 2 | 3>> = {};
  for (const slot of BOARD_SLOT_IDS) {
    const c = raw?.cols?.[slot];
    if (c === 1 || c === 2 || c === 3) cols[slot] = c;
  }

  return { lanes, cols, pageMode, leftCols };
}
