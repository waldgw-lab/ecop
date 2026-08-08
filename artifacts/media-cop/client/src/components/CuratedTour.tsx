import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Sparkles,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ArrowRight,
  X,
} from "lucide-react";
// Shared storm texture used by the MCOP header bar and favicon — reused here so
// the opener reads as part of the same product surface.
import headerStormBg from "@assets/image_1780976745611.png";

// =============================================================================
// Curated View feature walkthrough (Task #371).
//
// A self-contained, skippable walkthrough that highlights what makes Curated
// View unique versus the Classic/Visual feeds. Reused in TWO places:
//   1. The login-screen teaser popup ("Preview the tour").
//   2. Inside Curated View (auto on first visit + a replay button).
//
// Two phases:
//   • PAGE steps — spotlight coachmarks over the real /curated columns
//     (IE/MCOP Highlights, Aerial View, Top Stories), advanced with Next/Back.
//   • CLUSTER-DETAIL scroll-through — instead of auto-scrolling the detail with
//     a roaming pointer, the whole cluster detail is shown at once and the
//     viewer scrolls it themselves. An accent ring follows the section nearest a
//     focus line, an explainer bar updates its text to match, and a "scroll
//     down" prompt nudges the viewer through it (Task #371 follow-up).
//
// It is styled to match Curated View's dark terminal aesthetic and forces that
// look on its own (explicit dark palette + #5FA8C4 accent) so it renders the
// same whether opened from the dark Curated page or the light login screen.
// =============================================================================

const ACCENT = "#5FA8C4";

// --- Local "seen" memory + info-phase time-boxing -----------------------------
// These power the auto-show logic without any server telemetry (out of scope):
// just local flags + a hardcoded cutoff so the team can retire the auto-show /
// login teaser after the informational window. The replay button ignores both.
export const CURATED_TOUR_SEEN_KEY = "mcop.curatedTourSeen.v1";
export const CURATED_LOGIN_TEASER_DISMISSED_KEY =
  "mcop.curatedLoginTeaserDismissed.v1";

// Auto-show window. Auto-tour and the login teaser stop appearing on their own
// after this date (Phase 3 retirement) — no code change needed to disable them,
// just let the date pass. Bump it to extend the informational window.
export const CURATED_INFO_PHASE_UNTIL = new Date("2027-01-01T00:00:00Z");

export function isCuratedInfoPhaseActive(): boolean {
  return Date.now() < CURATED_INFO_PHASE_UNTIL.getTime();
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    /* localStorage unavailable (private mode) — auto-show simply repeats. */
  }
}

export function hasSeenCuratedTour(): boolean {
  return readFlag(CURATED_TOUR_SEEN_KEY);
}
export function markCuratedTourSeen(): void {
  writeFlag(CURATED_TOUR_SEEN_KEY);
}

export function isLoginTeaserDismissed(): boolean {
  return readFlag(CURATED_LOGIN_TEASER_DISMISSED_KEY);
}
export function dismissLoginTeaser(): void {
  writeFlag(CURATED_LOGIN_TEASER_DISMISSED_KEY);
}

// Session-scoped suppression of the auto-opener. Unlike the persistent
// CURATED_TOUR_SEEN_KEY flag, this lives only in memory (module scope): it
// survives in-app navigation — e.g. leaving to the Methodology page from the tour
// ending and returning to /curated — but resets on a full page reload. That is
// exactly what "Skip for now" (without "Don't show this again") needs: the opener
// stays down for the rest of this visit, then re-appears the next time the user
// opens the app.
let curatedOpenerSessionSuppressed = false;
export function isCuratedOpenerSessionSuppressed(): boolean {
  return curatedOpenerSessionSuppressed;
}
export function suppressCuratedOpenerForSession(): void {
  curatedOpenerSessionSuppressed = true;
}

// The in-app opener (the intro popup that precedes the tour on a viewer's first
// /curated visit) and the tour itself share ONE persistent "seen" flag
// (CURATED_TOUR_SEEN_KEY above). Auto-show is gated on BOTH that flag and the
// session-suppression flag, so it fires only on a genuine first visit that has
// not been seen or session-skipped (and only while the info phase is active — see
// Curated.tsx):
//   • "See what's new" or "Don't show this again" → markCuratedTourSeen()
//     (persistent): the opener never auto-shows again.
//   • "Skip for now" (no checkbox) → suppressCuratedOpenerForSession() only:
//     suppressed for this visit, re-shown on the next app load.
// The header replay button re-opens THIS opener (the welcome screen) so a replay
// always starts from the beginning, ignoring both auto-show flags.

// --- The page-level walkthrough steps (anchored coachmarks) -------------------
// Each step points at a REAL element on the live /curated page via an ordered
// list of `selectors` (the first one present in the DOM is the one highlighted).
// The tour scrolls that element into view, dims the rest of the page, draws an
// accent spotlight ring around it, and positions this card beside it. If NONE of
// a step's selectors resolve — e.g. on the login-screen teaser, or when a
// configurable column is hidden — the step falls back to a CENTERED card with a
// plain dim backdrop, so the walkthrough degrades gracefully and never breaks.
interface PageStep {
  title: string;
  body: string;
  // Optional rich body. When present it renders INSTEAD of `body`, letting a
  // step show inline styled fragments — e.g. the Top Stories card echoes the
  // feed's Topic·Focus metadata in its real accent-blue mono style so the
  // example tags visually associate with the metadata lines on the cards.
  bodyNode?: ReactNode;
  selectors: string[];
  // Preferred side to place the card relative to the target (auto-flips to fit).
  prefer?: SpotSide;
  // Optional testid of an element to click when this step becomes active. Used
  // to drive the IE↔MCOP carousel so the viewer actually SEES the left rail
  // switch between its two panes mid-tour. No-op if absent.
  clickOnEnter?: string;
  // Optional second titled block rendered below the main body on the same card.
  // Used so the IE Highlights and MCOP Highlights panes (which share one rail)
  // can be explained together on a single card.
  secondary?: { title: string; body: string };
  // When true, scroll the target so its TOP (its section header) sits just below
  // the sticky page header instead of centering it. Used for tall page sections
  // (Aerial View, Top Stories) so the section heading stays visible & highlighted
  // rather than being scrolled off the top of the viewport.
  alignTop?: boolean;
}

const PAGE_STEPS: PageStep[] = [
  // 1) IE Highlights + MCOP Highlights — the two panes that SHARE the left rail,
  // explained together on one card. We click the IE dot on enter so the rail
  // starts on IE; it auto-rotates to MCOP on its own.
  {
    title: "IE Highlights",
    body: "A read of the major information environment narratives, shaped twice daily by a Media Analyst and updated M-F at roughly 6:30 AM and 5:00 PM ET (times vary).",
    secondary: {
      title: "MCOP Highlights",
      body: "These are the top and emerging stories currently surfaced from across MCOP's own coverage.",
    },
    selectors: [
      '[data-testid="section-ie-highlights"]',
      '[data-testid="list-ie-highlights"]',
    ],
    prefer: "right",
    clickOnEnter: "dot-highlights-ie",
  },
  // 2) Aerial View — external trending-headline feed; the signal is the Blind Spot flags.
  {
    title: "Aerial View",
    body: 'An external source of trending headlines from around the web. Items flagged "Blind Spot" signify headlines not being covered or tracked in MCOP at the current moment — showing you what\'s being paid attention to in the news, regardless of relevance to MCOP.',
    selectors: ['[data-testid="section-competing-coverage"]'],
    prefer: "right",
    alignTop: true,
  },
  // 3) Top Stories — the familiar ranked column, now with clustered curated stories.
  {
    title: "Top Stories",
    body: "The same Top Stories from earlier MCOP versions — news stories ranked by recency and relevance. Each item is tagged with short metadata like \"Military Ops · Russia–Ukraine\" or \"Diplomacy · U.S.–Iran\" — so you can scan by subject and area of focus at a glance. What's new is curated stories: grouping coverage of the same media event into a single story instead of scattered, duplicate headlines. Click next to open a curated story.",
    // Render the example tags in the feed's real accent-blue mono metadata style
    // so they read as the same Topic·Focus labels shown on the cards.
    bodyNode: (
      <>
        The same Top Stories from earlier MCOP versions — news stories ranked by
        recency and relevance. Each item is tagged with short metadata like{" "}
        <span className="font-mono font-semibold tracking-tight text-[#5FA8C4]">
          Military Ops · Russia–Ukraine
        </span>{" "}
        or{" "}
        <span className="font-mono font-semibold tracking-tight text-[#5FA8C4]">
          Diplomacy · U.S.–Iran
        </span>{" "}
        — so you can scan by subject and area of focus at a glance.
        <span className="mt-3 block">
          What's new is curated stories: grouping coverage of the same media event
          into a single story instead of scattered, duplicate headlines. Click
          next to open a curated story.
        </span>
      </>
    ),
    selectors: [
      '[data-testid="section-top-stories"]',
      '[data-testid="list-ranked-stories"]',
      '[data-testid="empty-top-stories"]',
    ],
    prefer: "left",
    alignTop: true,
  },
];

// --- The cluster-detail sections (scroll-through phase) ------------------------
// Ordered to match the detail dialog's actual TOP-TO-BOTTOM layout so the active
// section advances monotonically as the viewer scrolls. Each section highlights
// the first selector that resolves INSIDE the detail dialog; a section whose
// element is absent for a given story is simply skipped.
interface DetailSection {
  kicker: string;
  title: string;
  body: string;
  selectors: string[];
}

const DETAIL_SECTIONS: DetailSection[] = [
  {
    kicker: "One event, told straight",
    title: "Neutral storyline",
    body: "A plain headline and summary that describe what happened before any single outlet's framing.",
    selectors: ['[data-testid="text-detail-lede"]'],
  },
  {
    kicker: "The common core",
    title: "Corroborated facts",
    body: "The facts every trusted source agrees on, pulled into one shared core — the factual record, separated from the noise.",
    // Falls back to the representative's own summary bullets / summary text when
    // a cluster hasn't synthesized corroborated facts yet, so this section still
    // resolves (and gets highlighted) on thinner clusters.
    selectors: [
      '[data-testid="list-detail-facts"]',
      '[data-testid="list-detail-bullets"]',
      '[data-testid="text-detail-summary"]',
    ],
  },
  {
    kicker: "Who said what",
    title: "Attributed claims & key quotes",
    body: "The key claims and quotes around the event, always tied to who said them — so attribution never gets lost.",
    selectors: ['[data-testid="list-detail-attributed-claims"]'],
  },
  {
    kicker: "Who forms the record",
    title: "Contributing sources",
    body: "The trusted outlets that can form the record. Each traces back to its original article — summary, link, timing, and outlet context one click away.",
    selectors: ['[data-testid="list-detail-contributing"]'],
  },
  {
    kicker: "Spot the spin",
    title: "Bias, framing & alignment",
    body: "Opinion, social, and lower-factuality sources are shown separately — attached for context and contrast, each with a rough percentage for how much its coverage lines up with the corroborated reporting.",
    selectors: [
      '[data-testid="list-detail-contrast"]',
      '[data-testid="banner-flagged-sources"]',
    ],
  },
  {
    kicker: "Context & framing",
    title: "Attached sources & original headlines",
    body: "Social posts, state media, and context-only sources attach here — and every outlet's original headline stays intact, so you can see how each framed the same event.",
    selectors: ['[data-testid="list-detail-attached"]'],
  },
];

// A summary of the detail anatomy, shown as the centered fallback when there is
// no live cluster to scroll (e.g. the login-screen "Preview the tour").
const DETAIL_FALLBACK_POINTS = DETAIL_SECTIONS.map((s) => s.title);

// The page-level step shown AFTER the viewer exits the cluster-detail
// scroll-through: the Custom Feed builder. Rendered as an ordinary anchored
// coachmark (same PageStep shape), and it falls back to a centered card when its
// target isn't on screen (e.g. the login teaser). The former "Methodology"
// coachmark is now folded into the centered ENDING screen (see the ending phase
// below), which offers an "Explore more" jump to the Methodology page.
const POST_DETAIL_STEPS: PageStep[] = [
  {
    title: "Custom Feed",
    body: "Build your own filtered view of the same curated stories — narrow by topic, region or country, time window, source type, and keywords. Signed in with Replit, your saved views and settings sync across devices.",
    selectors: ['[data-testid="section-custom-feed"]'],
    prefer: "left",
    alignTop: true,
  },
];

// Outer phases, in order: one per pre-detail page step, one for the detail
// scroll-through, one per post-detail page step (Custom Feed), then a final
// centered ENDING screen that closes the tour (styled like the opener, with an
// animated absorb into the header tour icon).
const PHASE_COUNT = PAGE_STEPS.length + 1 + POST_DETAIL_STEPS.length + 1;
const DETAIL_PHASE_INDEX = PAGE_STEPS.length;
// The final phase — a centered ending popup, not an anchored page coachmark.
const ENDING_PHASE_INDEX = PHASE_COUNT - 1;

// Resolve the page step for an outer index. Returns undefined AT the detail phase
// (index === DETAIL_PHASE_INDEX) and at the ending phase. Pre-detail steps map
// straight to PAGE_STEPS; post-detail steps sit just after the detail phase.
function pageStepForIndex(index: number): PageStep | undefined {
  if (index < DETAIL_PHASE_INDEX) return PAGE_STEPS[index];
  if (index === DETAIL_PHASE_INDEX) return undefined;
  if (index === ENDING_PHASE_INDEX) return undefined;
  return POST_DETAIL_STEPS[index - DETAIL_PHASE_INDEX - 1];
}

const DETAIL_SCROLLER_SELECTOR = '[data-testid="dialog-story-detail"]';

type SpotSide = "right" | "left" | "top" | "bottom";

interface SpotRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface TipPos {
  top: number;
  left: number;
  centered: boolean;
}

// Find the first selector in `selectors` that resolves to a visible element.
function findStepTarget(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) return el;
    }
  }
  return null;
}

// Walk up to the nearest actually-scrollable ancestor. The Curated page scrolls
// inside one container (h-screen overflow-y-auto) with a sticky header, rather
// than the window, so `alignTop` scrolling has to target that element.
function getScrollParent(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const oy = window.getComputedStyle(node).overflowY;
    if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

// Decide where the card sits relative to the spotlight, flipping to whichever
// side actually fits and clamping inside the viewport.
function placeTip(
  rect: SpotRect,
  tipW: number,
  tipH: number,
  prefer: SpotSide,
): TipPos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 16;
  const m = 12; // viewport margin
  const midY = rect.top + rect.height / 2 - tipH / 2;
  const midX = rect.left + rect.width / 2 - tipW / 2;
  const cands: Record<SpotSide, { left: number; top: number; ok: boolean }> = {
    right: { left: rect.left + rect.width + gap, top: midY, ok: rect.left + rect.width + gap + tipW <= vw - m },
    left: { left: rect.left - gap - tipW, top: midY, ok: rect.left - gap - tipW >= m },
    bottom: { left: midX, top: rect.top + rect.height + gap, ok: rect.top + rect.height + gap + tipH <= vh - m },
    top: { left: midX, top: rect.top - gap - tipH, ok: rect.top - gap - tipH >= m },
  };
  const order: SpotSide[] = [prefer, "right", "left", "bottom", "top"].filter(
    (s, i, a) => a.indexOf(s) === i,
  ) as SpotSide[];
  const chosen = order.find((s) => cands[s].ok) ?? "bottom";
  const c = cands[chosen];
  return {
    left: Math.min(Math.max(m, c.left), vw - tipW - m),
    top: Math.min(Math.max(m, c.top), vh - tipH - m),
    centered: false,
  };
}

interface CuratedTourProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Called when the user finishes ("Got it") or skips/closes the tour.
  onClose?: () => void;
  // The detail scroll-through phase needs a representative cluster's detail
  // dialog open. The host wires these to show/hide a sample story so the tour
  // can walk the breakdown sections. Both are no-ops on surfaces without a
  // sample (e.g. the login teaser), where the phase falls back to a centered
  // summary card instead.
  onOpenSampleStory?: () => void;
  onCloseSampleStory?: () => void;
  // Open the full Methodology page. Wired by the host to route to
  // /curated/methodology. Used by the ending screen's "Explore more" option
  // after its fly-into-the-header-icon animation. No-op on surfaces without a
  // methodology page (e.g. the login teaser), where that option simply ends.
  onOpenMethodology?: () => void;
}

export function CuratedTour({
  open,
  onOpenChange,
  onClose,
  onOpenSampleStory,
  onCloseSampleStory,
  onOpenMethodology,
}: CuratedTourProps) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<SpotRect | null>(null);
  const [tip, setTip] = useState<TipPos | null>(null);
  // Active detail section (scroll-driven) + how many sections are present, so the
  // explainer bar can show "3 of 6" for the story actually on screen.
  const [sectionIdx, setSectionIdx] = useState(0);
  const [sectionCount, setSectionCount] = useState(DETAIL_SECTIONS.length);
  const [sectionPos, setSectionPos] = useState(0);
  // Detail-phase readiness: a live cluster with at least one section is on
  // screen. When the grace timer lapses without one, we show the centered
  // fallback (login "Preview the tour" has no live story to scroll).
  const [detailReady, setDetailReady] = useState(false);
  const [noSample, setNoSample] = useState(false);
  const [hasScrolled, setHasScrolled] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  // Hold the detail overlays back for a beat so the viewer sees the cluster
  // detail window animate open first.
  const [entering, setEntering] = useState(false);
  const tipRef = useRef<HTMLDivElement>(null);
  // ENDING phase (final centered screen): its close animates the card flying
  // into the header tour icon (like the opener), and the "Explore more" option
  // hands off to a brief Methodology-link highlight before opening that page.
  const [endStage, setEndStage] = useState<"idle" | "absorbing" | "methodology">(
    "idle",
  );
  const [endAbsorbTransform, setEndAbsorbTransform] = useState("");
  const endCardRef = useRef<HTMLDivElement>(null);

  const detailPhase = index === DETAIL_PHASE_INDEX;
  const endingPhase = index === ENDING_PHASE_INDEX;
  const pageStep = pageStepForIndex(index);
  const section = DETAIL_SECTIONS[sectionIdx] ?? DETAIL_SECTIONS[0];
  const isLast = index === PHASE_COUNT - 1;

  // Always start at the first step whenever the tour is (re)opened.
  useEffect(() => {
    if (open) {
      setIndex(0);
      setRect(null);
      setTip(null);
      setSectionIdx(0);
      setDetailReady(false);
      setNoSample(false);
      setHasScrolled(false);
      setAtEnd(false);
      setEntering(false);
      setEndStage("idle");
      setEndAbsorbTransform("");
    }
  }, [open]);

  const close = () => {
    onCloseSampleStory?.();
    onOpenChange(false);
    onClose?.();
  };

  // CSS selector for the header tour icon the ending card flies into. Absent on
  // surfaces without the header (e.g. the login teaser), where the absorb step
  // falls back to running its follow-up immediately.
  const ABSORB_TARGET_SELECTOR = '[data-testid="button-curated-tour"]';

  // Fly the centered ending card into the header tour icon (the same absorb
  // flourish the opener uses on skip), then run `after`. Falls back to running
  // `after` immediately when the icon isn't on screen.
  const absorbEndingCard = (after: () => void) => {
    const card = endCardRef.current;
    const target = document.querySelector(
      ABSORB_TARGET_SELECTOR,
    ) as HTMLElement | null;
    if (card && target) {
      const c = card.getBoundingClientRect();
      const t = target.getBoundingClientRect();
      const dx = t.left + t.width / 2 - (c.left + c.width / 2);
      const dy = t.top + t.height / 2 - (c.top + c.height / 2);
      setEndAbsorbTransform(`translate(${dx}px, ${dy}px) scale(0.06)`);
      setEndStage("absorbing");
      window.setTimeout(after, 480);
    } else {
      after();
    }
  };

  // Ending screen — "Got it": absorb into the header icon, then close.
  const finishTour = () => {
    if (endStage !== "idle") return;
    absorbEndingCard(() => close());
  };

  // Ending screen — "Explore more: See the Methodology": absorb into the header
  // icon, then hand off to the methodology-highlight effect below.
  const finishToMethodology = () => {
    if (endStage !== "idle") return;
    absorbEndingCard(() => setEndStage("methodology"));
  };

  // Drive the sample detail dialog from the active phase: open it for the
  // scroll-through phase, close it for the page-level steps.
  useEffect(() => {
    if (!open) return;
    if (detailPhase) onOpenSampleStory?.();
    else onCloseSampleStory?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index]);

  // ENDING phase housekeeping: on entry, clear any stale spotlight/coachmark so
  // nothing lingers behind the centered ending card (or is revealed as its
  // backdrop fades during the absorb). On exit (e.g. Back), reset the stage.
  useEffect(() => {
    if (endingPhase) {
      setRect(null);
      setTip(null);
    } else {
      setEndStage("idle");
      setEndAbsorbTransform("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endingPhase]);

  // ENDING "Explore more" hand-off: once the card has absorbed into the header
  // icon (endStage === "methodology"), briefly spotlight the Methodology link,
  // then open the Methodology page and close the tour. If the link isn't present
  // (e.g. login teaser), open + close without the flourish.
  useEffect(() => {
    if (!open || endStage !== "methodology") return;
    const el = document.querySelector(
      '[data-testid="link-methodology"]',
    ) as HTMLElement | null;
    if (!el) {
      onOpenMethodology?.();
      close();
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const PAD = 6;
    const ring = () => {
      const r = el.getBoundingClientRect();
      setRect({
        top: r.top - PAD,
        left: r.left - PAD,
        width: r.width + PAD * 2,
        height: r.height + PAD * 2,
      });
    };
    ring();
    const t1 = window.setTimeout(ring, 260); // re-measure after the smooth scroll settles
    const t2 = window.setTimeout(() => {
      onOpenMethodology?.();
      close();
    }, 1050);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, endStage]);

  // Entering-the-detail beat: hold the ring + bar back so the cluster detail
  // window is seen animating open before the overlays land.
  useEffect(() => {
    if (!open || !detailPhase) {
      setEntering(false);
      return;
    }
    setEntering(true);
    setHasScrolled(false);
    setAtEnd(false);
    const t = window.setTimeout(() => setEntering(false), 650);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index]);

  // Fallback grace: if the detail phase can't find a live cluster to scroll
  // within a short window, switch to the centered summary card.
  useEffect(() => {
    if (!open || !detailPhase) {
      setNoSample(false);
      return;
    }
    if (detailReady) {
      setNoSample(false);
      return;
    }
    const t = window.setTimeout(() => setNoSample(true), 1400);
    return () => window.clearTimeout(t);
  }, [open, detailPhase, detailReady]);

  // If the active page step wants the IE↔MCOP carousel switched to a specific
  // pane, click its dot once the rail is on screen. A short retry covers the dot
  // mounting late; clicking re-arms the carousel's own dwell timer so the chosen
  // pane stays put while the viewer reads this step.
  useEffect(() => {
    if (!open || !pageStep?.clickOnEnter) return;
    const sel = `[data-testid="${pageStep.clickOnEnter}"]`;
    let tries = 0;
    const t = window.setInterval(() => {
      tries += 1;
      const dot = document.querySelector(sel) as HTMLElement | null;
      if (dot) {
        dot.click();
        window.clearInterval(t);
      } else if (tries >= 10) {
        window.clearInterval(t);
      }
    }, 100);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index]);

  // PAGE PHASE: locate the current step's target, scroll it into view, and keep
  // the spotlight rect in sync with scrolling / resizing. Re-runs on step
  // change. Falls back to a centered card if no selector resolves.
  useEffect(() => {
    if (!open || detailPhase || endingPhase) return;
    const step = pageStep!;
    let raf = 0;
    let scrolled = false;
    const PAD = 6;
    const apply = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      setRect({
        top: r.top - PAD,
        left: r.left - PAD,
        width: r.width + PAD * 2,
        height: r.height + PAD * 2,
      });
    };
    const locate = () => {
      const el = findStepTarget(step.selectors);
      if (!el) return false;
      if (!scrolled) {
        if (step.alignTop) {
          // Align the section's TOP (its header) just below the sticky page
          // header, so the heading stays on-screen and inside the spotlight
          // instead of being centered and scrolled off the top.
          const scroller = getScrollParent(el);
          if (scroller) {
            const header = scroller.querySelector<HTMLElement>("header.sticky");
            const headerH = header ? header.getBoundingClientRect().height : 0;
            const er = el.getBoundingClientRect();
            const cr = scroller.getBoundingClientRect();
            scroller.scrollBy({ top: er.top - cr.top - headerH - 12, behavior: "smooth" });
          } else {
            el.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        } else {
          el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        }
        scrolled = true;
      }
      apply(el);
      return true;
    };
    if (!locate()) setRect(null);
    // Poll for late-mounting targets for up to ~2.4s.
    let polls = 0;
    const poll = window.setInterval(() => {
      polls += 1;
      locate();
      if (polls >= 16) window.clearInterval(poll);
    }, 150);
    const onMove = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = findStepTarget(step.selectors);
        if (el) apply(el);
      });
    };
    window.addEventListener("resize", onMove);
    // Capture phase so nested column scroll containers are caught too.
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.clearInterval(poll);
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index]);

  // DETAIL PHASE: track which section is nearest a focus line as the viewer
  // scrolls the cluster detail, and keep an accent ring hugging its visible
  // portion. Poll briefly for the dialog + its sections to mount, then follow
  // the scroll. Nothing here auto-scrolls — the viewer drives it.
  useEffect(() => {
    if (!open || !detailPhase) return;
    let raf = 0;
    let attached = false;
    let cleanupScroll = () => {};
    const FOCUS_FRAC = 0.34;
    const PAD = 6;

    const recompute = () => {
      const scroller = document.querySelector(
        DETAIL_SCROLLER_SELECTOR,
      ) as HTMLElement | null;
      if (!scroller) {
        setDetailReady(false);
        setRect(null);
        return;
      }
      const cr = scroller.getBoundingClientRect();
      const focusY = cr.top + cr.height * FOCUS_FRAC;
      // Present sections, in order, that actually resolve inside this dialog.
      const present: { i: number; el: HTMLElement }[] = [];
      DETAIL_SECTIONS.forEach((s, i) => {
        const el = findStepTarget(s.selectors);
        if (el && scroller.contains(el) && el !== scroller) present.push({ i, el });
      });
      if (present.length === 0) {
        setDetailReady(false);
        setRect(null);
        return;
      }
      setDetailReady(true);
      const nearBottom =
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 16;
      // Active = last present section whose top has passed the focus line; force
      // the final section once scrolled to the very bottom (a section pinned near
      // the end may never reach the focus line on its own).
      let activePos = 0;
      for (let k = 0; k < present.length; k++) {
        if (present[k].el.getBoundingClientRect().top <= focusY) activePos = k;
      }
      if (nearBottom) activePos = present.length - 1;
      const active = present[activePos];
      setSectionIdx(active.i);
      setSectionPos(activePos);
      setSectionCount(present.length);
      setAtEnd(activePos >= present.length - 1 && (nearBottom || present.length === 1));
      // Ring = the visible slice of the active section within the dialog.
      const er = active.el.getBoundingClientRect();
      const top = Math.max(er.top, cr.top + 2);
      const bottom = Math.min(er.bottom, cr.bottom - 2);
      setRect({
        top: top - PAD,
        left: er.left - PAD,
        width: er.width + PAD * 2,
        height: Math.max(8, bottom - top) + PAD * 2,
      });
    };

    const onScroll = () => {
      const scroller = document.querySelector(
        DETAIL_SCROLLER_SELECTOR,
      ) as HTMLElement | null;
      if (scroller && scroller.scrollTop > 8) setHasScrolled(true);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recompute);
    };
    const onResize = onScroll;

    const attach = () => {
      const sc = document.querySelector(
        DETAIL_SCROLLER_SELECTOR,
      ) as HTMLElement | null;
      if (sc && !attached) {
        attached = true;
        sc.scrollTop = 0; // start at the top so the viewer reads from the beginning
        sc.addEventListener("scroll", onScroll, { passive: true });
        cleanupScroll = () => sc.removeEventListener("scroll", onScroll);
      }
    };

    window.addEventListener("resize", onResize);
    let polls = 0;
    const poll = window.setInterval(() => {
      polls += 1;
      attach();
      recompute();
      if (polls >= 24) window.clearInterval(poll);
    }, 150);
    attach();
    recompute();

    return () => {
      window.clearInterval(poll);
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
      cleanupScroll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index]);

  // Position the PAGE coachmark once we know the spotlight rect and card size.
  useLayoutEffect(() => {
    if (!open || detailPhase || endingPhase) return;
    const tipEl = tipRef.current;
    const tipW = tipEl?.offsetWidth ?? 360;
    const tipH = tipEl?.offsetHeight ?? 220;
    if (!rect) {
      setTip({
        top: (window.innerHeight - tipH) / 2,
        left: (window.innerWidth - tipW) / 2,
        centered: true,
      });
      return;
    }
    setTip(placeTip(rect, tipW, tipH, pageStep?.prefer ?? "right"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rect, index]);

  // Keyboard: Escape closes; arrows navigate the outer phases.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight" && !isLast)
        setIndex((i) => Math.min(PHASE_COUNT - 1, i + 1));
      else if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isLast]);

  if (!open) return null;

  const goBack = () => setIndex((i) => Math.max(0, i - 1));
  const goNext = () => setIndex((i) => Math.min(PHASE_COUNT - 1, i + 1));

  // Shared progress dots (one per outer phase).
  const progressDots = (
    <div className="flex items-center gap-1.5" data-testid="tour-progress">
      {Array.from({ length: PHASE_COUNT }).map((_, i) => (
        <span
          key={i}
          className="h-1.5 rounded-full transition-all"
          style={{
            width: i === index ? 20 : 6,
            backgroundColor: i === index ? ACCENT : "rgba(255,255,255,0.25)",
          }}
        />
      ))}
    </div>
  );

  // Card surface styling shared by the coachmark, fallback card, and bar.
  const surfaceStyle: React.CSSProperties = {
    backgroundColor: "hsl(0 0% 13%)",
    backgroundImage: [
      "radial-gradient(140% 90% at 50% -20%, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0) 55%)",
      "linear-gradient(155deg, #2e3237 0%, #212429 45%, #16181b 100%)",
    ].join(", "),
    border: "1px solid rgba(95,168,196,0.30)",
  };

  // Portal to <body> with a z-index above all app chrome (sticky header, market
  // ticker, toasts at z-[100], and the Radix detail dialog at z-50). Without the
  // portal the overlay is trapped in the page's local stacking context, so the
  // sticky header escapes the dim and appears "spotlighted" as the tour jumps.
  const showRing = detailPhase
    ? detailReady && !noSample && !entering && !!rect
    : !!rect;
  // Page fallback dims fully; the detail scroll-through and the ending screen
  // never dim from here (the ending card carries its own backdrop).
  const showDim = !detailPhase && !endingPhase && !rect;

  return createPortal(
    <div
      className="dark fixed inset-0"
      style={{ pointerEvents: "none", zIndex: 2147483000 }}
      data-testid="overlay-curated-tour"
    >
      {/* Click-blocker / dim. On page steps with a target, the dim comes from the
          spotlight's box-shadow (transparent here). With no target we dim fully.
          The detail scroll-through never dims — the whole cluster stays visible
          (its Radix overlay already dims the page behind it) — and it must let
          scroll events through to the dialog, so it takes no pointer events. */}
      <div
        className="absolute inset-0 transition-colors duration-300"
        style={{
          pointerEvents: detailPhase ? "none" : "auto",
          backgroundColor: showDim ? "rgba(2,6,10,0.78)" : "transparent",
        }}
        aria-hidden
      />

      {/* PAGE spotlight cutout: a transparent window over the target with a huge
          box-shadow that dims everything around it, plus an accent ring + glow. */}
      {!detailPhase && rect && (
        <div
          className="absolute rounded-md"
          style={{
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            pointerEvents: "none",
            boxShadow: `0 0 0 9999px rgba(2,6,10,0.78), 0 0 0 2px ${ACCENT}, 0 0 24px 4px rgba(95,168,196,0.55)`,
            transition:
              "top 320ms cubic-bezier(0.4,0,0.2,1), left 320ms cubic-bezier(0.4,0,0.2,1), width 320ms cubic-bezier(0.4,0,0.2,1), height 320ms cubic-bezier(0.4,0,0.2,1)",
          }}
          data-testid="spotlight-curated-tour"
        />
      )}

      {/* DETAIL ring: an accent ring (no dimming) that hugs the active section
          and glides to the next one as the viewer scrolls the cluster detail. */}
      {detailPhase && showRing && rect && (
        <div
          className="absolute rounded-md"
          style={{
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            pointerEvents: "none",
            boxShadow: `0 0 0 2px ${ACCENT}, 0 0 22px 5px rgba(95,168,196,0.5)`,
            transition:
              "top 260ms cubic-bezier(0.4,0,0.2,1), left 260ms cubic-bezier(0.4,0,0.2,1), width 260ms cubic-bezier(0.4,0,0.2,1), height 260ms cubic-bezier(0.4,0,0.2,1)",
          }}
          data-testid="ring-curated-tour"
        />
      )}

      {/* PAGE coachmark card. */}
      {!detailPhase && !endingPhase && (
        <div
          ref={tipRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="curated-tour-title"
          className="absolute w-[min(92vw,24rem)] overflow-hidden rounded-md text-zinc-100 shadow-2xl"
          style={{
            top: tip?.top ?? 0,
            left: tip?.left ?? 0,
            pointerEvents: "auto",
            opacity: tip ? 1 : 0,
            ...surfaceStyle,
            transition: "top 220ms ease, left 220ms ease, opacity 160ms ease",
          }}
          data-testid="dialog-curated-tour"
        >
          {/* Accent rule across the top — the terminal signature. */}
          <div className="h-1 w-full" style={{ backgroundColor: ACCENT }} />

          <div className="p-5">
            <h2
              id="curated-tour-title"
              className={`${pageStep?.secondary ? "text-lg" : "text-2xl"} font-semibold leading-snug`}
              style={{ color: ACCENT }}
              data-testid="text-tour-title"
            >
              {pageStep?.title}
            </h2>

            <p
              className="mt-3 text-sm leading-relaxed text-zinc-300"
              data-testid="text-tour-body"
            >
              {pageStep?.bodyNode ?? pageStep?.body}
            </p>

            {pageStep?.secondary && (
              <div
                className="mt-4 border-t border-zinc-700/60 pt-3"
                data-testid="block-tour-secondary"
              >
                <h3
                  className="text-lg font-semibold leading-snug"
                  style={{ color: ACCENT }}
                  data-testid="text-tour-secondary-title"
                >
                  {pageStep.secondary.title}
                </h3>
                <p
                  className="mt-1 text-sm leading-relaxed text-zinc-300"
                  data-testid="text-tour-secondary-body"
                >
                  {pageStep.secondary.body}
                </p>
              </div>
            )}

            <div className="mt-5">{progressDots}</div>

            {/* Controls: Skip on the left; Back/Next on the right. */}
            <div className="mt-5 flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={close}
                className="text-zinc-400 hover:text-zinc-200"
                data-testid="button-tour-skip"
              >
                Skip
              </Button>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={goBack}
                  disabled={index === 0}
                  className="border-zinc-600 bg-transparent text-zinc-200"
                  data-testid="button-tour-back"
                >
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Back
                </Button>
                <Button
                  size="sm"
                  onClick={isLast ? close : goNext}
                  className="text-white"
                  style={{ backgroundColor: ACCENT, borderColor: ACCENT }}
                  data-testid={isLast ? "button-tour-done" : "button-tour-next"}
                >
                  {isLast ? (
                    "Got it"
                  ) : (
                    <>
                      Next
                      <ChevronRight className="ml-1 h-4 w-4" />
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* DETAIL fallback (no live cluster to scroll — e.g. login preview): a
          centered card summarizing the curated-story anatomy. */}
      {detailPhase && noSample && (
        <div className="absolute inset-0 flex items-center justify-center p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="curated-tour-title"
            className="w-[min(92vw,26rem)] overflow-hidden rounded-md text-zinc-100 shadow-2xl"
            style={{ pointerEvents: "auto", ...surfaceStyle }}
            data-testid="dialog-curated-tour"
          >
            <div className="h-1 w-full" style={{ backgroundColor: ACCENT }} />
            <div className="p-5">
              <p
                className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-400"
                data-testid="text-tour-kicker"
              >
                Inside a curated story
              </p>
              <h2
                id="curated-tour-title"
                className="mt-1 text-2xl font-semibold leading-snug"
                style={{ color: ACCENT }}
                data-testid="text-tour-title"
              >
                One event, every angle
              </h2>
              <p
                className="mt-3 text-sm leading-relaxed text-zinc-300"
                data-testid="text-tour-body"
              >
                Open any clustered story to see the full breakdown, top to bottom:
              </p>
              <ul className="mt-3 space-y-1.5">
                {DETAIL_FALLBACK_POINTS.map((p) => (
                  <li
                    key={p}
                    className="flex items-start gap-2 text-sm text-zinc-200"
                  >
                    <span
                      className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full"
                      style={{ backgroundColor: ACCENT }}
                    />
                    {p}
                  </li>
                ))}
              </ul>

              <div className="mt-5">{progressDots}</div>

              <div className="mt-5 flex items-center justify-between gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={close}
                  className="text-zinc-400 hover:text-zinc-200"
                  data-testid="button-tour-skip"
                >
                  Skip
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={goBack}
                    className="border-zinc-600 bg-transparent text-zinc-200"
                    data-testid="button-tour-back"
                  >
                    <ChevronLeft className="mr-1 h-4 w-4" />
                    Back
                  </Button>
                  <Button
                    size="sm"
                    onClick={isLast ? close : goNext}
                    className="text-white"
                    style={{ backgroundColor: ACCENT, borderColor: ACCENT }}
                    data-testid={isLast ? "button-tour-done" : "button-tour-next"}
                  >
                    {isLast ? (
                      "Got it"
                    ) : (
                      <>
                        Next
                        <ChevronRight className="ml-1 h-4 w-4" />
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* DETAIL "scroll down" nudge: a prominent bouncing prompt over the cluster
          the first time the phase opens; it fades out once the viewer scrolls.
          Suppressed when the detail already fits on one screen (atEnd) so a short
          story never tells the viewer to scroll when there's nothing below. */}
      {detailPhase && detailReady && !noSample && !entering && !hasScrolled && !atEnd && (
        <div
          className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-1"
          style={{ bottom: "8.5rem", pointerEvents: "none" }}
          data-testid="prompt-scroll-down"
        >
          <span
            className="rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-white shadow-lg"
            style={{ backgroundColor: ACCENT }}
          >
            Scroll down to explore
          </span>
          <ChevronDown
            className="h-6 w-6 animate-bounce"
            style={{
              color: ACCENT,
              filter: "drop-shadow(0 0 6px rgba(95,168,196,0.9))",
            }}
          />
        </div>
      )}

      {/* DETAIL explainer bar: fixed at the bottom, updating its text to match the
          section under the ring as the viewer scrolls. Back returns to the page
          steps; Got it finishes. */}
      {detailPhase && detailReady && !noSample && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="curated-tour-title"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[min(94vw,44rem)] overflow-hidden rounded-md text-zinc-100 shadow-2xl"
          style={{
            pointerEvents: "auto",
            opacity: entering ? 0 : 1,
            ...surfaceStyle,
            transition: "opacity 200ms ease",
          }}
          data-testid="dialog-curated-tour"
        >
          <div className="h-1 w-full" style={{ backgroundColor: ACCENT }} />
          <div className="flex items-center gap-4 p-4">
            {/* Section counter */}
            <div
              className="flex-none rounded-md px-2.5 py-1 text-center"
              style={{ border: "1px solid rgba(95,168,196,0.35)" }}
            >
              <span
                className="font-mono text-sm font-semibold"
                style={{ color: ACCENT }}
                data-testid="text-tour-section-progress"
              >
                {sectionPos + 1} / {sectionCount}
              </span>
            </div>

            {/* Section explainer (updates as you scroll) */}
            <div className="min-w-0 flex-1">
              <h2
                id="curated-tour-title"
                className="text-base font-semibold leading-snug"
                style={{ color: ACCENT }}
                data-testid="text-tour-title"
              >
                {section.title}
              </h2>
              <p
                className="mt-0.5 text-sm leading-snug text-zinc-300"
                data-testid="text-tour-body"
              >
                {section.body}
              </p>
            </div>

            {/* Scroll hint / controls. The detail sections advance by SCROLLING,
                not a button — so there is no mid-scroll "Next" that would yank the
                viewer out of the story they're reading. While there is more below,
                only the "Scroll" nudge shows. Once the viewer reaches the end, a
                single Continue/Got it action appears to move on or finish. */}
            <div className="flex flex-none items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={close}
                className="text-zinc-400 hover:text-zinc-200"
                data-testid="button-tour-end"
              >
                <X className="mr-1 h-3.5 w-3.5" style={{ color: ACCENT }} />
                End tour
              </Button>
              {!atEnd && (
                <span
                  className="hidden items-center gap-1 text-xs font-medium text-zinc-400 sm:flex"
                  data-testid="hint-tour-scroll"
                >
                  <ChevronDown className="h-4 w-4 animate-bounce" style={{ color: ACCENT }} />
                  Scroll
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={goBack}
                className="border-zinc-600 bg-transparent text-zinc-200"
                data-testid="button-tour-back"
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                Back
              </Button>
              {atEnd && (
                <Button
                  size="sm"
                  onClick={isLast ? close : goNext}
                  className="text-white"
                  style={{ backgroundColor: ACCENT, borderColor: ACCENT }}
                  data-testid={isLast ? "button-tour-done" : "button-tour-next"}
                >
                  {isLast ? (
                    "Got it"
                  ) : (
                    <>
                      Continue
                      <ChevronRight className="ml-1 h-4 w-4" />
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ENDING screen — a centered popup (styled like the opener) that closes
          the tour. "Got it" flies the card into the header tour icon (so the
          viewer learns where to reopen the walkthrough later); the small
          "Explore more" option does the same, then highlights the Methodology
          link and opens that page. Hidden once the card hands off to the
          methodology highlight (endStage === "methodology"), which shows the
          page spotlight on the link instead. */}
      {endingPhase && endStage !== "methodology" && (
        <div
          className="absolute inset-0 flex items-center justify-center p-4"
          style={{ pointerEvents: "auto" }}
          data-testid="overlay-curated-tour-ending"
        >
          {/* Backdrop — fades out as the card is absorbed. A click ends the tour
              (same as "Got it") so a stray click never traps the viewer. */}
          <div
            className="absolute inset-0 bg-black/75 backdrop-blur-sm transition-opacity duration-300"
            style={{ opacity: endStage === "absorbing" ? 0 : 1 }}
            onClick={finishTour}
            aria-hidden
          />

          <div
            ref={endCardRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="curated-tour-ending-title"
            className="dark relative w-full max-w-lg overflow-hidden rounded-md text-zinc-100 shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200"
            style={{
              backgroundColor: "#0a0f14",
              backgroundImage: `url(${headerStormBg})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              border: "1px solid rgba(95,168,196,0.30)",
              transformOrigin: "center",
              transition:
                "transform 480ms cubic-bezier(0.4, 0, 0.2, 1), opacity 440ms ease-in",
              ...(endStage === "absorbing"
                ? { transform: endAbsorbTransform, opacity: 0 }
                : null),
            }}
            data-testid="dialog-curated-tour-ending"
          >
            {/* Dark wash + faint accent glow so light text reads over the storm
                image regardless of where it crops. */}
            <div
              className="absolute inset-0"
              style={{
                backgroundImage: [
                  "radial-gradient(120% 90% at 88% 115%, rgba(95,168,196,0.20) 0%, rgba(95,168,196,0) 52%)",
                  "linear-gradient(105deg, rgba(6,10,14,0.95) 0%, rgba(6,10,14,0.88) 44%, rgba(6,10,14,0.55) 100%)",
                ].join(", "),
              }}
              aria-hidden
            />

            {/* Accent rule across the top — the terminal signature. */}
            <div
              className="absolute inset-x-0 top-0 h-1"
              style={{ backgroundColor: ACCENT }}
            />

            <div className="relative flex flex-col gap-7 p-8 sm:p-10">
              <div className="max-w-md">
                <p
                  className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-200"
                  data-testid="text-tour-ending-eyebrow"
                >
                  That&apos;s the tour
                </p>
                <h2
                  id="curated-tour-ending-title"
                  className="mt-1 text-3xl font-bold uppercase leading-none tracking-tight sm:text-4xl"
                  style={{ color: ACCENT }}
                  data-testid="text-tour-ending-title"
                >
                  You&apos;re all set
                </h2>
                <p
                  className="mt-5 text-base italic leading-relaxed text-zinc-300"
                  data-testid="text-tour-ending-body"
                >
                  Reopen this walkthrough anytime from the tour icon in the
                  header.
                </p>
              </div>

              {progressDots}

              <div className="flex flex-col items-start gap-3">
                <Button
                  size="lg"
                  onClick={finishTour}
                  className="gap-3 rounded-md border border-white/15 bg-black/40 italic text-white backdrop-blur-md"
                  data-testid="button-tour-done"
                >
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded-md"
                    style={{ backgroundColor: ACCENT }}
                  >
                    <Sparkles className="h-4 w-4 text-white" />
                  </span>
                  Got it
                  <ArrowRight className="h-4 w-4" />
                </Button>

                {/* Small bottom option — same absorb flourish, then jumps to the
                    Methodology page. */}
                <button
                  type="button"
                  onClick={finishToMethodology}
                  className="bg-transparent p-0 text-sm font-medium italic hover:underline"
                  style={{ color: ACCENT }}
                  data-testid="button-tour-methodology"
                >
                  Explore more: See the Methodology
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* The End-tour control lives ON each card now (the "Skip" action on the
          page coachmark + centered fallback, and an "End tour" button on the
          detail scroll-through bar) rather than floating in the viewport corner,
          so the exit is always right next to whatever the viewer is reading. The
          ending screen has its own primary "Got it" close. Escape ends the tour
          from anywhere, covering the brief detail-phase entry beat before the bar
          appears. */}
    </div>,
    document.body,
  );
}

// =============================================================================
// Curated View opener (Task #371).
//
// The intro popup that precedes the tour on a viewer's first /curated visit.
// It offers: "See what's new" (launch the tour), "Skip for now", and a
// "Don't show this again" checkbox. On skip the card animates — shrinking and
// flying into the header Sparkles button — so the viewer learns where the tour
// lives afterward.
//
// Built as a self-controlled overlay (not a Radix Dialog) so the absorb-to-
// sparkle exit animation can be driven directly without fighting Radix's own
// open/close transitions.
// =============================================================================
interface CuratedTourOpenerProps {
  open: boolean;
  // User chose to take the tour ("See what's new").
  onTakeTour: () => void;
  // User skipped (or dismissed via backdrop/Escape). `dontShowAgain` reflects
  // the checkbox at the moment of skipping.
  onSkip: (dontShowAgain: boolean) => void;
  // CSS selector for the element the card flies into on skip (the replay button).
  absorbTargetSelector?: string;
}

export function CuratedTourOpener({
  open,
  onTakeTour,
  onSkip,
  absorbTargetSelector = '[data-testid="button-curated-tour"]',
}: CuratedTourOpenerProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [absorbing, setAbsorbing] = useState(false);
  const [absorbTransform, setAbsorbTransform] = useState("");
  const cardRef = useRef<HTMLDivElement>(null);

  // Reset transient state every time the opener (re)opens.
  useEffect(() => {
    if (open) {
      setDontShowAgain(false);
      setAbsorbing(false);
      setAbsorbTransform("");
    }
  }, [open]);

  const skip = () => {
    if (absorbing) return; // already animating out
    const dsa = dontShowAgain;
    const card = cardRef.current;
    const target = document.querySelector(
      absorbTargetSelector,
    ) as HTMLElement | null;
    if (card && target) {
      const c = card.getBoundingClientRect();
      const t = target.getBoundingClientRect();
      const dx = t.left + t.width / 2 - (c.left + c.width / 2);
      const dy = t.top + t.height / 2 - (c.top + c.height / 2);
      setAbsorbTransform(`translate(${dx}px, ${dy}px) scale(0.06)`);
      setAbsorbing(true);
      window.setTimeout(() => onSkip(dsa), 480);
    } else {
      // No target on screen — close immediately without the flourish.
      onSkip(dsa);
    }
  };

  // Escape closes the opener like Skip.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, absorbing, dontShowAgain]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      data-testid="overlay-curated-opener"
    >
      {/* Backdrop — fades out as the card is absorbed. */}
      <div
        className="absolute inset-0 bg-black/75 backdrop-blur-sm transition-opacity duration-300"
        style={{ opacity: absorbing ? 0 : 1 }}
        onClick={skip}
        aria-hidden
      />

      {/* The opener card — landscape "billboard" over the MCOP storm texture. */}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="curated-opener-title"
        className="dark relative w-full max-w-2xl overflow-hidden rounded-md text-zinc-100 shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200"
        style={{
          backgroundColor: "#0a0f14",
          backgroundImage: `url(${headerStormBg})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          border: "1px solid rgba(95,168,196,0.30)",
          transformOrigin: "center",
          transition:
            "transform 480ms cubic-bezier(0.4, 0, 0.2, 1), opacity 440ms ease-in",
          ...(absorbing ? { transform: absorbTransform, opacity: 0 } : null),
        }}
        data-testid="dialog-curated-opener"
      >
        {/* Dark wash + faint accent glow so light text reads over any part of
            the storm image regardless of where it crops. */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: [
              "radial-gradient(120% 90% at 88% 115%, rgba(95,168,196,0.20) 0%, rgba(95,168,196,0) 52%)",
              "linear-gradient(105deg, rgba(6,10,14,0.95) 0%, rgba(6,10,14,0.88) 44%, rgba(6,10,14,0.55) 100%)",
            ].join(", "),
          }}
          aria-hidden
        />

        {/* Accent rule across the top — the terminal signature. */}
        <div
          className="absolute inset-x-0 top-0 h-1"
          style={{ backgroundColor: ACCENT }}
        />

        <div className="relative flex min-h-[330px] flex-col justify-between gap-8 p-8 sm:p-10">
          <div className="max-w-md">
            <p
              className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-200"
              data-testid="text-opener-eyebrow"
            >
              Welcome to MCOP 3.0
            </p>
            <h2
              id="curated-opener-title"
              className="mt-1 text-4xl font-bold uppercase leading-none tracking-tight sm:text-5xl"
              style={{ color: ACCENT }}
              data-testid="text-opener-title"
            >
              Curated View
            </h2>

            <p
              className="mt-6 text-lg font-bold italic text-zinc-50"
              data-testid="text-opener-tagline"
            >
              One media event, every angle
            </p>
            <p
              className="mt-2 text-base italic leading-relaxed text-zinc-300"
              data-testid="text-opener-body"
            >
              Corroborated facts, key claims, source bias, and media framing —
              at MCOP speed.
            </p>
          </div>

          {/* Bottom row: primary CTA on the left, skip + opt-out on the right. */}
          <div className="flex flex-wrap items-end justify-between gap-4">
            <Button
              size="lg"
              onClick={onTakeTour}
              className="gap-3 rounded-md border border-white/15 bg-black/40 italic text-white backdrop-blur-md"
              data-testid="button-opener-take-tour"
            >
              <span
                className="flex h-7 w-7 items-center justify-center rounded-md"
                style={{ backgroundColor: ACCENT }}
              >
                <Sparkles className="h-4 w-4 text-white" />
              </span>
              See what&apos;s new
              <ArrowRight className="h-4 w-4" />
            </Button>

            <div className="flex flex-col items-start gap-2">
              <button
                type="button"
                onClick={skip}
                className="text-base font-medium italic transition-opacity hover:opacity-80"
                style={{ color: ACCENT }}
                data-testid="button-opener-skip"
              >
                Skip for now
              </button>
              <label
                className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400"
                data-testid="label-opener-dont-show"
              >
                <Checkbox
                  checked={dontShowAgain}
                  onCheckedChange={(v) => setDontShowAgain(v === true)}
                  className="border-zinc-500 data-[state=checked]:border-[#5FA8C4] data-[state=checked]:bg-[#5FA8C4]"
                  data-testid="checkbox-opener-dont-show"
                />
                Don&apos;t show this again
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default CuratedTour;
