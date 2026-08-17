import { cloneElement, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, Link } from "wouter";
import { useQuery, useMutation, keepPreviousData } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import Login from "@/pages/Login";
import { useToast } from "@/hooks/use-toast";
import type { OutletRegistry, CompetingCoverageItem } from "@shared/schema";
import {
  buildOutletIndex,
  findOutlet,
  type OutletIndex,
} from "@shared/outletRegistry";
import { deriveContentType, getEffectiveContentKindWithTitle, type ContentKind, type StoredContentKind } from "@shared/contentKind";
import { isPlaceholderImageUrl } from "@shared/placeholderImage";
import { buildCuratedHeroImages } from "@/lib/curatedHeroImages";
import { LINK_MERGE_REASONS, SCORE_ADJUST_REASONS, type ReasonOption } from "@shared/curatedReasonVocab";
import ViewSwitcher from "@/components/ViewSwitcher";
import {
  primaryTopicShortLabel,
  inferPrimaryTopic,
  inferFocus,
  CONFLICT_TRACK_FOCUS,
  PRIMARY_TOPICS,
  CONFLICT_TRACKS,
} from "@shared/classificationVocab";
import {
  Archive,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronLeft,
  AlertTriangle,
  ArrowRightLeft,
  ChevronRight,
  Circle,
  Clock,
  Copy,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  BookOpen,
  Film,
  Headphones,
  Radio,
  Globe,
  ImagePlus,
  Info,
  Layers,
  Link2,
  Combine,
  ListChecks,
  Loader2,
  Lock,
  LogIn,
  Megaphone,
  Menu,
  MessageSquareQuote,
  Minus,
  MonitorCog,
  Pencil,
  Pentagon,
  Plus,
  RefreshCw,
  Moon,
  Search,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Tags,
  TrendingUp,
  Unlink,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { CuratedFeedScale } from "@/lib/curatedFeedScale";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/components/ThemeProvider";
import { useCuratedPrefsSync } from "@/lib/curatedPrefsSync";
import { CURATED_THEME_STORAGE_KEY, resolveCuratedTheme } from "@/lib/curatedTheme";
import {
  TIMEZONE_OPTIONS,
  useTimezone,
  setSelectedTimezone,
  getTzAbbrev,
} from "@/lib/timezone";
import { formatShareDateTime, formatCuratedPostTime, formatCuratedPublicationDTG } from "@/lib/postTime";
import { escapeHtml, copyRichText } from "@/lib/richCopy";
import CuratedLayoutBoard, {
  loadCuratedBoardLayout,
  selectR1Lanes,
  BOARD_LAYOUT_KEY,
  CURATED_BOARD_LAYOUT_CHANGED_EVENT,
  type BoardLayout,
  type BoardSlotId,
  type BoardSectionKey,
} from "@/components/CuratedLayoutBoard";
import {
  useCuratedColumnWeights,
  computeColumnTemplate,
  useColumnWidthObserver,
  ColumnResizeHandles,
} from "@/components/CuratedColumnResizer";
import CopyShareButton from "@/components/CopyShareButton";
import OverflowHeadlineTooltip from "@/components/OverflowHeadlineTooltip";
import {
  formatNewsCandidateContext,
} from "@/lib/curatedCandidateContext";
import {
  formatIeHighlightsIntro,
  formatIeNarrativeLabel,
} from "@/lib/ieHighlightsPresentation";
import {
  CuratedTour,
  CuratedTourOpener,
  markCuratedTourSeen,
  hasSeenCuratedTour,
  isCuratedInfoPhaseActive,
  isCuratedOpenerSessionSuppressed,
  suppressCuratedOpenerForSession,
} from "@/components/CuratedTour";
import MarketTicker, { type TickerMode } from "@/components/MarketTicker";
import CuratedFeedbackDialog from "@/components/CuratedFeedbackDialog";
import LiveBroadcastBanner from "@/components/LiveBroadcastBanner";
import TruthSocialFeed from "@/components/TruthSocialFeed";
import OutletLogo from "@/components/OutletLogo";
import SentDefenderFeed from "@/components/SentDefenderFeed";
import XPostsFeed from "@/components/XPostsFeed";
import southcomAvatar from "@assets/avatars/southcom.png";
import centcomAvatar from "@assets/avatars/centcom.png";
import secwarAvatar from "@assets/avatars/secwar.png";
import jointStaffAvatar from "@assets/avatars/thejointstaff.png";
import secStateAvatar from "@assets/avatars/secstate.png";
import stateDeptAvatar from "@assets/image_1782432175489.png";
import seanParnellAvatar from "@assets/avatars/seanparnellasw.png";
import pressSecAvatar from "@assets/avatars/presssec.png";
import secArmyAvatar from "@assets/avatars/secarmy.png";
import secAfAvatar from "@assets/avatars/secafofficial.png";
import sentDefenderAvatar from "@assets/avatars/sentdefender.png";
import mataOsintAvatar from "@assets/avatars/mata_osint.png";
import osint613Avatar from "@assets/avatars/osint613.png";
import osintTechnicalAvatar from "@assets/avatars/osinttechnical.png";
import firstSquawkAvatar from "@assets/avatars/firstsquawk.png";
import aggregateOsintAvatar from "@assets/avatars/aggregateosint.png";
import pizzintWatchAvatar from "@assets/avatars/pizzintwatch.png";
import globalMilInfoAvatar from "@assets/avatars/global_mil_info.png";
import dowResponseAvatar from "@assets/avatars/dowresponse.png";
import dowCioDaviesAvatar from "@assets/avatars/dowciodavies.png";
import rapidResponse47Avatar from "@assets/avatars/rapidresponse47.png";
import barakRavidAvatar from "@assets/image_1781103950425.png";
import jeremyBobAvatar from "@assets/image_1781103824374.png";
import philStewartAvatar from "@assets/image_1781104226731.png";
import ericSchmittAvatar from "@assets/image_1781103190294.png";
import alexWardAvatar from "@assets/image_1781104014252.png";
import eucomAvatar from "@assets/image_1781459823891.png";
import uspacomAvatar from "@assets/image_1782299093837.png";
import africomAvatar from "@assets/image_1781459836026.png";
import northcomAvatar from "@assets/image_1781459844158.png";
import spacecomAvatar from "@assets/image_1781459852739.png";
import cybercomAvatar from "@assets/image_1781459860092.png";
import socomAvatar from "@assets/image_1781459865278.png";
import stratcomAvatar from "@assets/image_1781459868956.png";
import transcomAvatar from "@assets/image_1781459872751.png";
import whiteHouseAvatar from "@assets/image_1782432044640.png";
import FirstAlertFeed from "@/components/FirstAlertFeed";
import type {
  TruthSocialPost,
  XPost,
  OsintPost,
  RapidResponsePost,
  DOWResponsePost,
  FirstAlert,
} from "@shared/schema";
import { hasSecurityContext } from "@shared/securityContext";
import mcopLogoWhite from "@assets/Logo5_WHITE_1782606805634.png";
import headerStormBg from "@assets/image_1780976745611.png";
import mcopBotIcon from "@assets/generated_images/mcop_bot_robot_mascot_icon.png";
import { CURATED_SHOWCASE_STORY } from "@/components/curatedShowcaseStory";
import { MCOPBotDialog } from "@/components/MCOPBotDialog";

// Shared search-text builder for CuratedStory objects — mirrors the global
// storySearchText useMemo field-for-field so the link/merge dialog and the Top
// Stories search always match on the same inputs. Any field added here must
// also be added to the global storySearchText useMemo (and vice versa).
// NOTE: This is a pure function with no React hooks, so it can safely live at
// module scope. Call it from both the global map and the dialog candidate map.
function buildStorySearchText(s: {
  title?: string | null; displayTitle?: string | null;
  summary?: string | null; lede?: string | null; source?: string | null;
  category?: string | null; primaryTopic?: string | null;
  region?: string | null; country?: string | null;
  conflictTrack?: string | null; scope?: string | null;
  summaryBullets?: string[] | null; facts?: string[] | null;
  attributedClaims?: string[] | null; matchedKeywords?: string[] | null;
  countryPair?: string[] | null;
  members?: Array<{ source?: string | null; title?: string | null; displayTitle?: string | null }> | null;
}): string {
  const parts: (string | null | undefined)[] = [
    s.title, s.displayTitle, s.summary, s.lede, s.source,
    s.category, s.primaryTopic, s.region, s.country, s.conflictTrack, s.scope,
  ];
  if (s.summaryBullets) parts.push(...s.summaryBullets);
  if (s.facts) parts.push(...s.facts);
  if (s.attributedClaims) parts.push(...s.attributedClaims);
  if (s.matchedKeywords) parts.push(...s.matchedKeywords);
  if (s.countryPair) parts.push(...s.countryPair);
  if (s.members) {
    for (const m of s.members) {
      parts.push(m.source, m.title, m.displayTitle);
    }
  }
  return parts.filter((p): p is string => !!p).join(" \u241f ").toLowerCase();
}

// ── Link/merge dialog relevance ranking ─────────────────────────────────────
// Stop words that carry no discriminating signal for same-event matching.
const LINK_STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "by","from","as","is","it","its","be","was","are","were","been","has",
  "have","had","that","this","these","those","not","no","up","into","over",
  "after","says","say","said","amid","amid","amid","over","amid","amid",
  "new","can","all","will","may","one","two","three","after","how","who",
  "what","when","where","why","than","more","than","also","while","about",
]);

// Tokenize a headline into discriminating content tokens (≥3 chars, no stops).
function tokenizeForLink(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.toLowerCase()
    .split(/[\s\-–—,.:;!?'"()\[\]\/\\]+/)
    .filter((t) => t.length >= 3 && !LINK_STOP_WORDS.has(t));
}

// Score a candidate against source-item tokens.
// Title hits are weighted 3×; body/metadata hits 1×. Returns 0 if no source tokens.
function scoreCandidateVsSource(
  sourceTokens: string[],
  titleText: string,
  bodyText: string,
): number {
  if (!sourceTokens.length) return 0;
  let score = 0;
  for (const tok of sourceTokens) {
    if (titleText.includes(tok)) score += 3;
    else if (bodyText.includes(tok)) score += 1;
  }
  return score;
}
// ─────────────────────────────────────────────────────────────────────────────

// A "generic outlet logo" (favicon/clearbit fallback) must never masquerade as
// an article photo. When that's all the backend could find, treat it as no image.
function isFaviconImage(u: string | null | undefined): boolean {
  if (!u) return false;
  if (u.includes("/favicon") || isPlaceholderImageUrl(u)) return true;
  // SPH Media CDN (sphdigital.com.sg — cassette. for The Straits Times and any
  // sibling SPH title) serves both the outlet's brand masthead logo and real
  // article photos from identical opaque-hash URL shapes. A raw CDN URL appearing
  // in ogImageUrl means the image was ingested but not yet re-hosted in object
  // storage (pre-enrichment or rejected-logo state). Real SPH article photos are
  // always stored as /objects/… paths after enrichment. Suppressing the raw CDN
  // URL here prevents the logo from briefly rendering on cards between ingest and
  // the first enrichment cycle. Matches the whole SPH family (see
  // OUTLET_LOGO_CDN_CONFIGS in shared/placeholderImage.ts).
  if (u.includes('sphdigital.com.sg')) return true;
  return false;
}
// Some outlets publish their own brand logo AS the article share-image (og:image),
// so it gets scraped and persisted as a "real" image with no URL signal that it's
// just a logo. TASS (the blue "tass" card) is the prime example. Treat any image
// from these outlets the same as a favicon — it's never a real article photo.
const LOGO_SHARE_IMAGE_OUTLETS = new Set(["tass"]);
function isLogoShareOutlet(source: string | null | undefined): boolean {
  return !!source && LOGO_SHARE_IMAGE_OUTLETS.has(source.trim().toLowerCase());
}
// Real photo → pass through. Favicon/logo (URL pattern OR known logo-as-share
// outlet) → null (no image). Empty → null. The allowFallback parameter is kept
// for call-site compatibility but is no longer used — all placeholder/missing
// cases return null so the card degrades to a clean text-only layout.
function resolveArticleImage(
  u: string | null | undefined,
  allowFallback = true,
  source?: string | null,
): string | null {
  if (!u) return null;
  if (isFaviconImage(u) || isLogoShareOutlet(source)) return null;
  return u;
}

// -----------------------------------------------------------------------------
// CURATED VIEW (CV) — slide-accurate 3-column layout.
//
// SCOPE: This page is curated-view-only. It reuses existing read-only MCOP
// endpoints for real data and a small set of curated-only endpoints
// (`/api/curated/*`) for clustering-derived source counts. It never mutates
// MCOP state.
//
// PLACEHOLDER CONVENTION: Anything MCOP cannot produce yet is rendered as DUMMY
// data in YELLOW (see <Demo> / demoText) and tagged in code with a
// `CV-PLACEHOLDER` comment so it is trivial to find and replace later.
// -----------------------------------------------------------------------------

const demoText = "text-yellow-600 dark:text-yellow-400";

/**
 * Curated-only profile avatars for the "U.S. X Feed" (XPostsFeed), keyed by the
 * post's sourceAccount handle. Provided manually one at a time; accounts without
 * an entry fall back to the feed's text-initial avatar.
 */
const US_X_FEED_AVATARS: Record<string, string> = {
  SOUTHCOM: southcomAvatar,
  CENTCOM: centcomAvatar,
  SecWar: secwarAvatar,
  // Pete Hegseth's personal account is the same person as @SecWar, so it
  // shares the SecWar profile logo.
  PeteHegseth: secwarAvatar,
  TheJointStaff: jointStaffAvatar,
  SecRubio: secStateAvatar,
  StateDept: stateDeptAvatar,
  SeanParnellASW: seanParnellAvatar,
  PressSec: pressSecAvatar,
  SecArmy: secArmyAvatar,
  SecAFOfficial: secAfAvatar,
  US_EUCOM: eucomAvatar,
  USPACOM: uspacomAvatar,
  // Legacy @INDOPACOM posts (pre-rename) reuse the new Pacific Command logo.
  INDOPACOM: uspacomAvatar,
  USAfricaCommand: africomAvatar,
  USNorthernCmd: northcomAvatar,
  US_SpaceCom: spacecomAvatar,
  US_CYBERCOM: cybercomAvatar,
  USSOCOM: socomAvatar,
  US_STRATCOM: stratcomAvatar,
  US_TRANSCOM: transcomAvatar,
  WhiteHouse: whiteHouseAvatar,
  DoWCIODavies: dowCioDaviesAvatar,
};

/** Curated-only U.S. X Feed display names ("Display Name · @handle"). */
const US_X_FEED_NAMES: Record<string, string> = {
  PressSec: "Karoline Leavitt · @PressSec",
  TheJointStaff: "The Joint Staff · @thejointstaff",
  SecArmy: "Secretary of the Army · @SecArmy",
  SecAFOfficial: "Office of the Secretary of the Air Force · @SecAFOfficial",
  StateDept: "U.S. Department of State · @StateDept",
  SecWar: "Secretary of War Pete Hegseth · @SecWar",
  PeteHegseth: "Pete Hegseth · @PeteHegseth",
  SOUTHCOM: "U.S. Southern Command · @Southcom",
  CENTCOM: "U.S. Central Command · @CENTCOM",
  SecRubio: "Secretary Marco Rubio · @SecRubio",
  SeanParnellASW: "Sean Parnell · @SeanParnellASW",
  RapidResponse47: "Rapid Response 47 · @RapidResponse47",
  DOWResponse: "DOW Rapid Response · @DOWResponse",
  US_EUCOM: "U.S. European Command · @US_EUCOM",
  USPACOM: "U.S. Pacific Command · @USPACOM",
  // Legacy @INDOPACOM posts adopt the new Pacific Command identity.
  INDOPACOM: "U.S. Pacific Command · @USPACOM",
  USAfricaCommand: "U.S. Africa Command (AFRICOM) · @USAfricaCommand",
  USNorthernCmd: "U.S. Northern Command · @USNorthernCmd",
  US_SpaceCom: "U.S. Space Command · @US_SpaceCom",
  US_CYBERCOM: "U.S. Cyber Command · @US_CYBERCOM",
  USSOCOM: "USSOCOM · @USSOCOM",
  US_STRATCOM: "United States Strategic Command · @US_STRATCOM",
  US_TRANSCOM: "USTRANSCOM · @US_TRANSCOM",
  WhiteHouse: "The White House · @WhiteHouse",
  DoWCIODavies: "DoW CIO Kirsten Davies · @DoWCIODavies",
};

/** Text-avatar initials for U.S. X Feed accounts that have no profile image. */
const US_X_FEED_INITIALS: Record<string, string> = {
  RapidResponse47: "R47",
  DOWResponse: "DR",
};

/** Curated-only Response Feed profile avatars (keyed by sourceAccount). */
const RESPONSE_FEED_AVATARS: Record<string, string> = {
  RapidResponse47: rapidResponse47Avatar,
  DOWResponse: dowResponseAvatar,
};

// The Response feeds (@RapidResponse47 + @DOWResponse) are folded INTO the U.S.
// X Feed column, so its avatar/name lookups must cover both sets.
const US_X_FEED_ALL_AVATARS: Record<string, string> = {
  ...US_X_FEED_AVATARS,
  ...RESPONSE_FEED_AVATARS,
};

// Per-account multi-select for the U.S. X Feed header toggle. Each entry maps a
// user-facing checkbox to one or more underlying sourceAccount handles. Every
// ingested U.S. X Feed account is listed here so the viewer can toggle it; posts
// whose sourceAccount is NOT covered by any group still render (the multi-select
// only gates the accounts it explicitly lists).
type UsXFeedAccount = { id: string; label: string; handles: string[] };
const US_X_FEED_ACCOUNT_GROUPS: UsXFeedAccount[] = [
  // Grouped by type, alphabetical within each type.
  // Press / Rapid Response.
  { id: "WhiteHouse", label: "@WhiteHouse", handles: ["WhiteHouse"] },
  { id: "PressSec", label: "@PressSec", handles: ["PressSec"] },
  { id: "RapidResponse47", label: "@RapidResponse47", handles: ["RapidResponse47"] },
  // State / diplomacy.
  { id: "StateDept", label: "@StateDept", handles: ["StateDept"] },
  { id: "SecRubio", label: "@SecRubio", handles: ["SecRubio"] },
  // Dept. of War leadership. SecWar and Pete Hegseth's personal account are the
  // same person but are now independently toggleable (separate checkboxes).
  { id: "DOWResponse", label: "@DOWResponse", handles: ["DOWResponse"] },
  { id: "DoWCIODavies", label: "@DoWCIODavies", handles: ["DoWCIODavies"] },
  { id: "PeteHegseth", label: "@PeteHegseth", handles: ["PeteHegseth"] },
  { id: "SecWar", label: "@SecWar", handles: ["SecWar"] },
  { id: "SeanParnellASW", label: "@SeanParnellASW", handles: ["SeanParnellASW"] },
  // Joint Staff.
  { id: "TheJointStaff", label: "@TheJointStaff", handles: ["TheJointStaff"] },
  // Service secretaries.
  { id: "SecArmy", label: "@SecArmy", handles: ["SecArmy"] },
  { id: "SecAFOfficial", label: "@SecAFOfficial", handles: ["SecAFOfficial"] },
  // Combatant commands (alphabetical by label). USPACOM was formerly @INDOPACOM;
  // its legacy handle is kept so already-stored posts still map to this checkbox.
  { id: "USAfricaCommand", label: "AFRICOM", handles: ["USAfricaCommand"] },
  { id: "CENTCOM", label: "CENTCOM", handles: ["CENTCOM"] },
  { id: "US_CYBERCOM", label: "CYBERCOM", handles: ["US_CYBERCOM"] },
  { id: "US_EUCOM", label: "EUCOM", handles: ["US_EUCOM"] },
  { id: "USNorthernCmd", label: "NORTHCOM", handles: ["USNorthernCmd"] },
  { id: "USSOCOM", label: "SOCOM", handles: ["USSOCOM"] },
  { id: "SOUTHCOM", label: "SOUTHCOM", handles: ["SOUTHCOM"] },
  { id: "US_SpaceCom", label: "SPACECOM", handles: ["US_SpaceCom"] },
  { id: "US_STRATCOM", label: "STRATCOM", handles: ["US_STRATCOM"] },
  { id: "US_TRANSCOM", label: "TRANSCOM", handles: ["US_TRANSCOM"] },
  { id: "USPACOM", label: "USPACOM", handles: ["USPACOM", "INDOPACOM"] },
];
// Map each underlying handle to its group id for fast per-post lookup.
const US_X_FEED_HANDLE_TO_GROUP: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const g of US_X_FEED_ACCOUNT_GROUPS) {
    for (const h of g.handles) m[h] = g.id;
  }
  return m;
})();
// Every U.S. X Feed account ships toggled ON by default.
const US_X_FEED_DEFAULT_ON = US_X_FEED_ACCOUNT_GROUPS.map((g) => g.id);
// Storage key is versioned (:v3) so the regrouped/reordered default set — the
// split SecWar/Hegseth checkboxes and the @INDOPACOM→@USPACOM rename — reaches
// return visitors whose saved selection predates it (all accounts on).
const US_X_FEED_STORAGE_KEY = "selectedUsXFeedAccounts:v3";

// Curated social bloc layout switcher (Task #252): 3 / 2 / 1 columns. Persisted
// so the choice survives reloads. Drives both the column arrangement and the
// per-mode avatar/text scale.
type SocialLayout = 3 | 2 | 1;
const SOCIAL_LAYOUT_STORAGE_KEY = "curatedSocialLayout";
const SOCIAL_LAYOUT_SCALE: Record<SocialLayout, CuratedFeedScale> = {
  3: "sm",
  2: "md",
  1: "lg",
};

// sessionStorage key used to hand the currently-open story popup across the
// route change to /curated/methodology and back. The methodology route remounts
// a fresh Curated view, so we stash the open story here on "See more in
// methodology" and restore it when the user returns to /curated — keeping the
// popup open exactly where they left it instead of a blank feed.
const CURATED_PENDING_STORY_KEY = "mcop-curated-pending-story";

// -----------------------------------------------------------------------------
// Unified "Configure Layout" panel (Task #258 follow-up). A single page-level
// modal controls the visibility, item counts and column arrangement of every
// Curated section. All of its state is loaded from / persisted to one
// localStorage key so the viewer's arrangement survives reloads. (socialLayout
// keeps its own key above for backward-compat.)
// -----------------------------------------------------------------------------
const LAYOUT_CONFIG_KEY = "curatedLayoutConfig";
// Bumped when the default item counts change. Configs saved before this version
// get just the stale count defaults refreshed on next load (Aerial buckets are
// now 5/5), while keeping every visibility toggle and column placement the user
// has chosen.
const LAYOUT_CONFIG_VERSION = 3;

// The six "movable" feeds can live in EITHER the left or right column, or be
// turned off entirely. Everything else is a simple on/off.
type FeedPlacement = "left" | "right" | "off";
type MovableFeedKey =
  | "truth"
  | "secwar"
  | "osint"
  | "press"
  | "customFeed"
  | "firstAlert";
// Stable render order for movable feeds within whichever column they land in.
const MOVABLE_FEED_ORDER: MovableFeedKey[] = [
  "truth",
  "secwar",
  "osint",
  "press",
  "customFeed",
  "firstAlert",
];

interface CuratedLayoutConfig {
  showTicker: boolean;
  tickerMode: TickerMode;
  showLiveBanner: boolean;
  showSearchBar: boolean;
  showMcopBot: boolean;
  showMcopHighlights: boolean;
  showIeHighlights: boolean;
  showAerial: boolean;
  showAerialDomestic: boolean;
  aerialDomesticMax: number;
  showAerialIntl: boolean;
  aerialIntlMax: number;
  showAerialTrending: boolean;
  showTopStories: boolean;
  showStateNarratives: boolean;
  showPreviewPane: boolean;
  topStoriesCount: number;
  storiesFeedCount: number;
  // Movable feeds — each carries a column placement (left / right / off)
  // instead of a single on/off so the viewer can place it wherever they want.
  truthPlacement: FeedPlacement;
  secwarPlacement: FeedPlacement;
  osintPlacement: FeedPlacement;
  pressPlacement: FeedPlacement;
  customFeedPlacement: FeedPlacement;
  firstAlertPlacement: FeedPlacement;
}

const LAYOUT_CONFIG_DEFAULTS: CuratedLayoutConfig = {
  showTicker: true,
  tickerMode: "standard",
  showLiveBanner: true,
  showSearchBar: true,
  showMcopBot: true,
  showMcopHighlights: true,
  showIeHighlights: true,
  showAerial: true,
  showAerialDomestic: true,
  aerialDomesticMax: 5,
  showAerialIntl: true,
  aerialIntlMax: 5,
  showAerialTrending: true,
  showTopStories: true,
  showStateNarratives: true,
  showPreviewPane: true,
  topStoriesCount: 5,
  storiesFeedCount: 30,
  // Default placements mirror where each feed lived before it became movable:
  // DataMinr in the left column, the social + custom feeds on the right.
  truthPlacement: "right",
  secwarPlacement: "right",
  osintPlacement: "right",
  pressPlacement: "right",
  customFeedPlacement: "right",
  firstAlertPlacement: "left",
};

const AERIAL_MAX_OPTIONS = [3, 5, 10, 15, 20];
// Aerial View always shows this many per category collapsed; the configurable
// per-bucket max only controls how many are reachable behind "See more".
const AERIAL_COLLAPSED_COUNT = 3;
const TOP_STORIES_COUNT_OPTIONS = [3, 5, 7, 10];
const STORIES_FEED_COUNT_OPTIONS = [10, 15, 20, 30, 50];

function loadLayoutConfig(): CuratedLayoutConfig {
  try {
    const raw = localStorage.getItem(LAYOUT_CONFIG_KEY);
    if (!raw) return { ...LAYOUT_CONFIG_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<CuratedLayoutConfig> & {
      __v?: number;
      // Legacy on/off booleans (pre-placement). Migrated to a column placement
      // below so older saved layouts keep every visibility choice.
      showTruth?: boolean;
      showSecwar?: boolean;
      showOsint?: boolean;
      showPress?: boolean;
      showCustomFeed?: boolean;
      showFirstAlert?: boolean;
    };
    const merged = { ...LAYOUT_CONFIG_DEFAULTS, ...parsed };

    // Guard the ticker motion mode against any stale/invalid saved value.
    if (
      merged.tickerMode !== "standard" &&
      merged.tickerMode !== "fast" &&
      merged.tickerMode !== "fade" &&
      merged.tickerMode !== "push"
    ) {
      merged.tickerMode = LAYOUT_CONFIG_DEFAULTS.tickerMode;
    }

    // Migrate the movable feeds from their legacy on/off booleans to a column
    // placement. Each feed keeps the column it lived in before it became movable
    // (DataMinr on the left; the social + custom feeds on the right); a feed the
    // user had turned off stays off. A placement already saved wins outright.
    const migratePlacement = (
      saved: FeedPlacement | undefined,
      legacy: boolean | undefined,
      defaultColumn: "left" | "right",
    ): FeedPlacement => {
      if (saved === "left" || saved === "right" || saved === "off") return saved;
      if (legacy === false) return "off";
      return defaultColumn;
    };
    merged.truthPlacement = migratePlacement(parsed.truthPlacement, parsed.showTruth, "right");
    merged.secwarPlacement = migratePlacement(parsed.secwarPlacement, parsed.showSecwar, "right");
    merged.osintPlacement = migratePlacement(parsed.osintPlacement, parsed.showOsint, "right");
    merged.pressPlacement = migratePlacement(parsed.pressPlacement, parsed.showPress, "right");
    merged.customFeedPlacement = migratePlacement(parsed.customFeedPlacement, parsed.showCustomFeed, "right");
    merged.firstAlertPlacement = migratePlacement(parsed.firstAlertPlacement, parsed.showFirstAlert, "left");

    // One-time count-default refresh on a version bump. The Aerial buckets have
    // shipped 10/10, then 20/20, and are now 5/5; refresh anyone still sitting on
    // a prior default while keeping any value the user intentionally chose.
    if (!parsed.__v || parsed.__v < LAYOUT_CONFIG_VERSION) {
      if (parsed.storiesFeedCount === undefined || parsed.storiesFeedCount === 20) {
        merged.storiesFeedCount = LAYOUT_CONFIG_DEFAULTS.storiesFeedCount;
      }
      if (
        parsed.aerialDomesticMax === undefined ||
        parsed.aerialDomesticMax === 10 ||
        parsed.aerialDomesticMax === 20
      ) {
        merged.aerialDomesticMax = LAYOUT_CONFIG_DEFAULTS.aerialDomesticMax;
      }
      if (
        parsed.aerialIntlMax === undefined ||
        parsed.aerialIntlMax === 10 ||
        parsed.aerialIntlMax === 20
      ) {
        merged.aerialIntlMax = LAYOUT_CONFIG_DEFAULTS.aerialIntlMax;
      }
    }
    return merged;
  } catch {
    return { ...LAYOUT_CONFIG_DEFAULTS };
  }
}

/** Curated-only OSINT X Feed avatar/name overrides (keyed by sourceAccount). */
const OSINT_FEED_AVATARS: Record<string, string> = {
  sentdefender: sentDefenderAvatar,
  MATA_osint: mataOsintAvatar,
  Osint613: osint613Avatar,
  Osinttechnical: osintTechnicalAvatar,
  FirstSquawk: firstSquawkAvatar,
  AggregateOsint: aggregateOsintAvatar,
  pizzintwatch: pizzintWatchAvatar,
  Global_Mil_Info: globalMilInfoAvatar,
};
const OSINT_FEED_NAMES: Record<string, string> = {
  sentdefender: "OSINTdefender · @sentdefender",
  MATA_osint: "Military Air Tracking Alliance · @MATA_osint",
  Osint613: "Open Source Intel · @Osint613",
  Osinttechnical: "OSINTtechnical · @Osinttechnical",
  FirstSquawk: "First Squawk · @FirstSquawk",
  AggregateOsint: "OSINT Aggregator · @AggregateOsint",
  pizzintwatch: "Pentagon Pizza Watch · @pizzintwatch",
  Global_Mil_Info: "GMI · @Global_Mil_Info",
};

/** Curated-only Journalists X Feed display names (keyed by sourceAccount). */
const JOURNALIST_FEED_NAMES: Record<string, string> = {
  BarakRavid: "Barak Ravid · @BarakRavid",
  jeremybob1: "Yonah Jeremy Bob · @jeremybob1",
  phildstewart: "Phil Stewart · @phildstewart",
  EricSchmittNYT: "Eric Schmitt · @EricSchmittNYT",
  alexbward: "Alex Ward · @alexbward",
};
/** Curated-only Journalists X Feed avatars (keyed by sourceAccount). */
const JOURNALIST_FEED_AVATARS: Record<string, string> = {
  BarakRavid: barakRavidAvatar,
  jeremybob1: jeremyBobAvatar,
  phildstewart: philStewartAvatar,
  EricSchmittNYT: ericSchmittAvatar,
  alexbward: alexWardAvatar,
};

// Per-account multi-select for the OSINT X Feed and Press X Feed (Task #258),
// mirroring the U.S. X Feed control. Each group maps a checkbox to one
// sourceAccount handle; posts whose sourceAccount is not listed here always
// render (the multi-select only gates the accounts it explicitly lists). The
// "@handle" portion of the display-name maps above is used as the short label.
type FeedAccountGroup = { id: string; label: string };
function handleFromName(name: string): string {
  const sep = name.indexOf(" · ");
  return sep === -1 ? name : name.slice(sep + 3);
}
function buildFeedAccountGroups(names: Record<string, string>): FeedAccountGroup[] {
  return Object.entries(names).map(([id, name]) => ({ id, label: handleFromName(name) }));
}
// sentdefender_posts rows carry no sourceAccount column, so they key as
// 'sentdefender' (matching SentDefenderFeed's own fallback).
const OSINT_FEED_ACCOUNT_GROUPS = buildFeedAccountGroups(OSINT_FEED_NAMES);
const OSINT_FEED_GROUP_IDS = new Set(OSINT_FEED_ACCOUNT_GROUPS.map((g) => g.id));
const OSINT_FEED_DEFAULT_ON = OSINT_FEED_ACCOUNT_GROUPS.map((g) => g.id);
const OSINT_FEED_STORAGE_KEY = "selectedOsintXFeedAccounts:v2";

const PRESS_FEED_ACCOUNT_GROUPS = buildFeedAccountGroups(JOURNALIST_FEED_NAMES);
const PRESS_FEED_GROUP_IDS = new Set(PRESS_FEED_ACCOUNT_GROUPS.map((g) => g.id));
const PRESS_FEED_DEFAULT_ON = PRESS_FEED_ACCOUNT_GROUPS.map((g) => g.id);
const PRESS_FEED_STORAGE_KEY = "selectedPressXFeedAccounts:v2";

// Per-X-feed "Hide reposts" display filter (Task #372). Persisted like the
// account selections so the choice survives reloads; default ON (reposts hidden
// unless the viewer re-enables them). Reachable from both the feed dropdown and
// the Configure Layout board; both flip the same page state so the surfaces stay
// consistent. Keys are versioned (:v2) so the new default reaches return visitors.
const HIDE_REPOSTS_US_X_STORAGE_KEY = "curatedHideRepostsUsXFeed:v2";
const HIDE_REPOSTS_OSINT_STORAGE_KEY = "curatedHideRepostsOsintFeed:v2";
const HIDE_REPOSTS_PRESS_STORAGE_KEY = "curatedHideRepostsPressFeed:v2";

// Read a persisted boolean setting; returns defaultValue when unset or on error.
function loadBoolSetting(storageKey: string, defaultValue = false): boolean {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === null) return defaultValue;
    return stored === "true";
  } catch {
    return defaultValue;
  }
}

// Read a persisted account selection, falling back to all-on defaults. Filters
// out any stale ids no longer in the group list and guarantees at least one id
// remains selected (the keep-at-least-one rule must hold even after a reload).
function loadFeedSelection(
  storageKey: string,
  groups: FeedAccountGroup[],
  defaults: string[],
): string[] {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === null) return [...defaults];
    const savedArr = JSON.parse(saved) as string[];
    const valid = new Set(groups.map((g) => g.id));
    const filtered = savedArr.filter((id) => valid.has(id));
    return filtered.length > 0 ? filtered : [...defaults];
  } catch {
    return [...defaults];
  }
}

/**
 * Shared small, greyed-out per-account selector used by every multi-account
 * Curated social feed (U.S. X, OSINT X, Press X — Task #258). Opens a compact
 * checkbox pane. Enforces the keep-at-least-one rule: when only a single account
 * remains checked, its checkbox is locked (disabled) so a feed can never be
 * emptied.
 */
function FeedAccountSelector({
  title,
  ariaLabel,
  testIdButton,
  testIdPrefix,
  groups,
  selected,
  setSelected,
  hideReposts,
  setHideReposts,
  hideRepostsTestId,
}: {
  title: string;
  ariaLabel: string;
  testIdButton: string;
  testIdPrefix: string;
  groups: FeedAccountGroup[];
  selected: string[];
  setSelected: React.Dispatch<React.SetStateAction<string[]>>;
  // Optional per-feed "Hide reposts" toggle, surfaced beneath the account
  // checkboxes. When provided, the popover renders the control; the page owns
  // the state so the Configure Layout board can flip the same value.
  hideReposts?: boolean;
  setHideReposts?: (v: boolean) => void;
  hideRepostsTestId?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center rounded-md border [border-color:hsl(var(--input))] bg-transparent px-1 py-0.5 shadow-md shadow-black/30 hover-elevate"
          aria-label={ariaLabel}
          data-testid={testIdButton}
        >
          <ChevronDown className="h-3 w-3 text-muted-foreground/70" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="curated-surface w-64 p-2 shadow-md shadow-black/30" align="start">
        <div className="px-1 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
          {title}
        </div>
        <div className="space-y-0.5 max-h-[50vh] overflow-y-auto">
          {groups.map((g) => {
            const isChecked = selected.includes(g.id);
            // Locked when this is the last remaining checked account.
            const isLocked = isChecked && selected.length === 1;
            return (
              <label
                key={g.id}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-md ${
                  isLocked
                    ? "opacity-60 cursor-not-allowed"
                    : "cursor-pointer hover-elevate"
                }`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  disabled={isLocked}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelected((prev) =>
                        prev.includes(g.id) ? prev : [...prev, g.id],
                      );
                    } else {
                      // Keep-at-least-one: never remove the final selection.
                      setSelected((prev) =>
                        prev.length <= 1 ? prev : prev.filter((x) => x !== g.id),
                      );
                    }
                  }}
                  className="w-4 h-4 cursor-pointer disabled:cursor-not-allowed accent-curated-accent"
                  data-testid={`${testIdPrefix}-${g.id}`}
                />
                <span className="text-xs flex-1 min-w-0 truncate">{g.label}</span>
                {isLocked && (
                  <Lock className="h-3 w-3 text-muted-foreground/60 flex-shrink-0" />
                )}
              </label>
            );
          })}
        </div>
        {setHideReposts && (
          <>
            <div className="my-1.5 border-t [border-color:hsl(var(--border))]" />
            <label className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer hover-elevate">
              <input
                type="checkbox"
                checked={!!hideReposts}
                onChange={(e) => setHideReposts(e.target.checked)}
                className="w-4 h-4 cursor-pointer accent-curated-accent"
                data-testid={hideRepostsTestId}
              />
              <span className="text-xs flex-1 min-w-0 truncate">Hide reposts</span>
            </label>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Small inline tag marking a value as not-yet-real curated demo data. */
function DemoTag() {
  return (
    <span
      className={`ml-1.5 inline-block rounded-sm border border-yellow-500/40 px-1 text-[9px] font-bold uppercase tracking-wider ${demoText}`}
      data-testid="tag-demo"
    >
      Demo
    </span>
  );
}

/**
 * Flat, underlined section heading — matches the slide's terminal aesthetic
 * (no elevated cards; sections separated by hairline rules).
 */
function SectionHeading({
  title,
  titleNode,
  demo,
  className,
  headingClassName,
  actions,
  tooltip,
  indicator,
}: {
  title: string;
  // Optional rich heading content rendered inside the <h2> in place of the
  // plain `title` string — e.g. to color one segment of the title (the country
  // name in "State Controlled Narratives · RUSSIA"). `title` is still required
  // and stays the source for the data-testid / aria text so those stay stable.
  titleNode?: React.ReactNode;
  demo?: boolean;
  className?: string;
  // Override for the <h2> sizing/wrapping. Defaults to the standard big,
  // single-line section heading. A longer label (e.g. "State Controlled
  // Narratives · Iran") passes a smaller, wrap-allowed class so it fits a
  // narrow rail without overflowing. `uppercase tracking-wide font-bold` are
  // kept for every section so the design language stays consistent.
  headingClassName?: string;
  actions?: React.ReactNode;
  tooltip?: React.ReactNode;
  // Small inline control rendered immediately after the title (e.g. a rotating
  // column's pane dots). Sits next to the heading rather than in its own band so
  // it never reads as wasted space.
  indicator?: React.ReactNode;
}) {
  // Controlled open state so the tooltip can be toggled on tap (touch devices)
  // as well as opened on hover (desktop). pointer-events-auto on TooltipContent
  // keeps the "See more in methodology" link inside it clickable.
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const heading = (
    <h2
      className={`font-bold uppercase tracking-wide ${headingClassName ?? "text-lg whitespace-nowrap"} ${demo ? demoText : ""}`}
    >
      {titleNode ?? title}
    </h2>
  );
  return (
    <div
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border pb-1.5 mb-2.5 ${className ?? ""}`}
    >
      {tooltip ? (
        <TooltipProvider>
          <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
            <TooltipTrigger asChild>
              <div
                className="flex items-center gap-1.5 cursor-help"
                onClick={() => setTooltipOpen((o) => !o)}
                data-testid={`tooltip-section-${title.toLowerCase().replace(/\s+/g, "-")}`}
              >
                {heading}
                <Info className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs leading-relaxed pointer-events-auto">
              {tooltip}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        heading
      )}
      {indicator}
      {demo && <DemoTag />}
      {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
    </div>
  );
}

/**
 * Far-right curated social column (Task #182). A single slot that rotates over
 * time between the OSINT X Feed and the Journalists X Feed via a horizontal
 * slide. Rotation pauses while the user hovers the column or scrolls within a
 * pane. Curated-lane-only — both feeds read curated-gated endpoints.
 */
const SOCIAL_ROTATE_INTERVAL_MS = 12_000;
// The Highlights carousel (IE <-> MCOP) holds denser, read-it summaries rather
// than a fast social feed, so it dwells longer — roughly how long it takes to
// skim a pane before it rotates. Kept separate so the social carousel's cadence
// is untouched.
const HIGHLIGHTS_ROTATE_INTERVAL_MS = 22_000;
// When IE Highlights has no real content to show — it's still loading or has
// collapsed to the compact "Last Updated" card (stale) — there's nothing to read
// on that pane, so dwell only briefly on IE and linger longer on MCOP Highlights.
const IE_CONDENSED_DWELL_MS = 6_000;
const MCOP_LONG_DWELL_MS = 34_000;
const SOCIAL_SCROLL_PAUSE_MS = 4_000;

type SocialPane = {
  key: string;
  title: string;
  node: React.ReactNode;
  // Optional small control rendered in the header next to the rotate dots while
  // this pane is active (e.g. the OSINT / Press per-account selector — Task #258).
  headerControl?: React.ReactNode;
  // Plain-language explainer shown via a hover/tap (i) icon on the section
  // heading — same methodology-tooltip pattern as other curated sections.
  tooltip?: React.ReactNode;
};

function RotatingSocialColumn({
  panes,
  trailingControl,
  sectionTestId = "section-osint",
  fill = false,
}: {
  // One or more feed panes the column rotates through. With a single pane the
  // dots/rotation collapse to a static column.
  panes: SocialPane[];
  // Optional control rendered to the RIGHT of the rotate dots (the social bloc's
  // layout switcher lives here on the rightmost column — Task #252).
  trailingControl?: React.ReactNode;
  sectionTestId?: string;
  // When true (no standalone sections sit below the R1 bloc), the column grows
  // to fill the right column's full height at lg+ instead of capping at 480px.
  fill?: boolean;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  // Hover and scroll pause are tracked independently so a scroll's resume timer
  // can never clear an active hover pause (and vice versa). Rotation is paused
  // whenever EITHER signal is active.
  const [isHovering, setIsHovering] = useState(false);
  const [isScrollPaused, setIsScrollPaused] = useState(false);
  const paused = isHovering || isScrollPaused;
  const scrollPauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the active pane in range when the pane set shrinks (e.g. the user
  // switches layout mode or toggles a feed off).
  useEffect(() => {
    if (activeIndex > panes.length - 1) setActiveIndex(0);
  }, [panes.length, activeIndex]);
  const safeIndex = activeIndex < panes.length ? activeIndex : 0;

  useEffect(() => {
    if (paused || panes.length <= 1) return;
    const t = setInterval(
      () => setActiveIndex((i) => (i + 1) % panes.length),
      SOCIAL_ROTATE_INTERVAL_MS,
    );
    return () => clearInterval(t);
  }, [paused, panes.length]);

  useEffect(
    () => () => {
      if (scrollPauseTimer.current) clearTimeout(scrollPauseTimer.current);
    },
    [],
  );

  const handleScroll = () => {
    setIsScrollPaused(true);
    if (scrollPauseTimer.current) clearTimeout(scrollPauseTimer.current);
    scrollPauseTimer.current = setTimeout(
      () => setIsScrollPaused(false),
      SOCIAL_SCROLL_PAUSE_MS,
    );
  };

  return (
    <section
      data-testid={sectionTestId}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      className={fill ? "lg:h-full lg:flex lg:flex-col" : undefined}
    >
      <SectionHeading
        title={panes[safeIndex]?.title ?? ""}
        tooltip={panes[safeIndex]?.tooltip}
        actions={
          <>
            {panes[safeIndex]?.headerControl}
            {panes.length > 1 && (
              <div className="flex items-center gap-1.5">
                {panes.map((p, i) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setActiveIndex(i)}
                    aria-label={`Show ${p.title}`}
                    data-testid={`dot-social-${p.key}`}
                    className={`h-2 w-2 rounded-full transition-colors ${
                      i === safeIndex ? "bg-primary" : "bg-muted-foreground/40"
                    }`}
                  />
                ))}
              </div>
            )}
            {trailingControl}
          </>
        }
      />
      <div className={`overflow-hidden${fill ? " lg:flex-1 lg:min-h-0" : ""}`}>
        <div
          className={`flex transition-transform duration-500 ease-in-out${
            fill ? " lg:h-full" : ""
          }`}
          style={{
            width: `${panes.length * 100}%`,
            transform: `translateX(-${safeIndex * (100 / panes.length)}%)`,
          }}
        >
          {panes.map((p) => (
            <div
              key={p.key}
              className={`shrink-0${fill ? " lg:flex lg:flex-col lg:min-h-0" : ""}`}
              style={{ width: `${100 / panes.length}%` }}
            >
              <div
                className={`curated-scroll overflow-y-auto overflow-x-hidden pr-2 min-h-[240px] ${
                  fill
                    ? "max-h-[480px] lg:max-h-none lg:flex-1 lg:min-h-0"
                    : "max-h-[480px]"
                }`}
                onScroll={handleScroll}
                data-testid={`scroll-social-${p.key}`}
              >
                {p.node}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * Generic auto-rotating single-slot column (Task #223). Hosts an ordered list of
 * panes and rotates between them on the same cadence/behavior as
 * RotatingSocialColumn (auto-rotate, hover/scroll pause, sliding transition, dot
 * indicators). The active pane's title drives the SectionHeading, and each pane
 * may contribute its own `actions` (e.g. IE Highlights' See more / Download)
 * which render alongside the rotation dots only while that pane is active.
 */
function RotatingColumn({
  panes,
  sectionTestId,
  keyPrefix,
  heightClass = "max-h-[480px]",
  headingClassName,
  intervalMs = SOCIAL_ROTATE_INTERVAL_MS,
}: {
  panes: {
    key: string;
    title: string;
    // Optional rich heading content (forwarded to SectionHeading) when a pane
    // wants to color part of its title; `title` stays the plain-text source for
    // aria/testids.
    titleNode?: React.ReactNode;
    demo?: boolean;
    actions?: React.ReactNode;
    // Optional plain-language explainer shown via the SectionHeading (i) icon
    // when this pane is active — used to spell out acronym pane titles.
    tooltip?: React.ReactNode;
    node: React.ReactNode;
    // Optional per-pane dwell. When set, this pane is shown for this many ms
    // before rotating (overriding the column-wide `intervalMs`), so individual
    // panes can linger longer or pass by quicker than the others.
    intervalMs?: number;
  }[];
  sectionTestId: string;
  keyPrefix: string;
  // Default dwell for panes that don't specify their own `intervalMs`, in ms.
  intervalMs?: number;
  // Height of each pane's scroll viewport. Pass a FIXED height (e.g.
  // "h-[260px]") to keep the section a constant size regardless of which pane is
  // active or how tall its content is — so swapping panes never reflows the rest
  // of the column. A taller pane just scrolls inside this fixed window.
  heightClass?: string;
  // Optional override for the active pane's SectionHeading <h2> sizing/wrapping
  // (forwarded to SectionHeading). Lets a long section label fit a narrow rail.
  headingClassName?: string;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isHovering, setIsHovering] = useState(false);
  const [isScrollPaused, setIsScrollPaused] = useState(false);
  const paused = isHovering || isScrollPaused;
  const scrollPauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safeIndex = activeIndex < panes.length ? activeIndex : 0;
  // Dwell of the pane currently on screen — its own `intervalMs` if set,
  // otherwise the column default. Falling back to a number keeps existing
  // single-cadence callers behaving exactly as before.
  const activeIntervalMs = panes[safeIndex]?.intervalMs ?? intervalMs;

  useEffect(() => {
    if (paused || panes.length <= 1) return;
    // setTimeout (re-armed whenever the active pane changes) instead of a fixed
    // setInterval, so each pane can be shown for its own duration.
    const t = setTimeout(
      () => setActiveIndex((i) => (i + 1) % panes.length),
      activeIntervalMs,
    );
    return () => clearTimeout(t);
  }, [paused, panes.length, activeIntervalMs, safeIndex]);

  useEffect(
    () => () => {
      if (scrollPauseTimer.current) clearTimeout(scrollPauseTimer.current);
    },
    [],
  );

  const handleScroll = () => {
    setIsScrollPaused(true);
    if (scrollPauseTimer.current) clearTimeout(scrollPauseTimer.current);
    scrollPauseTimer.current = setTimeout(
      () => setIsScrollPaused(false),
      SOCIAL_SCROLL_PAUSE_MS,
    );
  };

  const active = panes[safeIndex];

  return (
    <section
      data-testid={sectionTestId}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <SectionHeading
        title={active.title}
        titleNode={active.titleNode}
        demo={active.demo}
        headingClassName={headingClassName}
        actions={active.actions}
        tooltip={active.tooltip}
        indicator={
          panes.length > 1 ? (
            <div className="flex items-center gap-1 ml-1 shrink-0">
              {panes.map((p, i) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setActiveIndex(i)}
                  aria-label={`Show ${p.title}`}
                  data-testid={`dot-${keyPrefix}-${p.key}`}
                  className={`h-1.5 w-1.5 rounded-full transition-colors ${
                    i === safeIndex ? "bg-primary" : "bg-muted-foreground/40"
                  }`}
                />
              ))}
            </div>
          ) : undefined
        }
      />
      <div className="overflow-hidden">
        <div
          className="flex transition-transform duration-500 ease-in-out"
          style={{
            width: `${panes.length * 100}%`,
            transform: `translateX(-${safeIndex * (100 / panes.length)}%)`,
          }}
        >
          {panes.map((p) => (
            <div
              key={p.key}
              className="shrink-0"
              style={{ width: `${100 / panes.length}%` }}
            >
              <div
                className={`curated-scroll overflow-y-auto overflow-x-hidden ${heightClass} pr-2`}
                onScroll={handleScroll}
                data-testid={`scroll-${keyPrefix}-${p.key}`}
              >
                {p.node}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// Top Stories header sort control (Task #643) — purely a client-side
// reordering of the already-loaded, search-filtered Top Stories list.
// "priority-desc" reproduces the historical default ordering byte-for-byte.
type TopStoriesSortMode =
  | "priority-desc"
  | "priority-asc"
  | "newest"
  | "oldest"
  | "topic";

const TOP_STORIES_SORT_OPTIONS: { value: TopStoriesSortMode; label: string }[] = [
  { value: "priority-desc", label: "Priority: High → Low" },
  { value: "priority-asc", label: "Priority: Low → High" },
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "topic", label: "Topic / focus area" },
];

// Editor view modes (Task #834 rework) — rendered in the SAME header Select as
// the sort options, but held in SEPARATE state so the sort pipeline (and the
// byte-identical "priority-desc" default) is never disturbed. Selecting a view mode
// swaps only the ranked-list BODY: 'radar' shows contributing-source items the
// AI scored too low (promote OR attach actions), 'hidden' shows editor-hidden
// stories with un-hide actions, 'link-candidates' shows ALL recent
// attach-eligible items (attach-only + opinion/analysis/video) with a cluster
// picker. The two lists are disjoint by construction. 'feed' = normal list.
type EditorViewMode = "feed" | "radar" | "hidden" | "link-candidates";

const EDITOR_VIEW_OPTIONS: { value: Exclude<EditorViewMode, "feed">; label: string }[] = [
  { value: "radar", label: "Scored too low (Radar)" },
  { value: "hidden", label: "Hidden stories" },
  { value: "link-candidates", label: "Attach candidates" },
];

export interface CuratedStory {
  id: string;
  type: "scraped" | "manual" | "curated";
  title: string;
  // Display-only cleaned title from the server (daily live-blog prefixes like
  // "Iran war day 106:" / "Live:" stripped). `title` stays the original for
  // search + region/country heuristics; only what the user reads uses this.
  displayTitle?: string | null;
  summary: string;
  summaryBullets: string[] | null;
  ogImageUrl: string | null;
  // Curated lane — every DISTINCT photo across the cluster's members, primary
  // first. Powers the image carousel on the detail hero and the main-page card.
  // [single image] or empty for standalone single-source rows.
  memberImages?: string[] | null;
  videoUrl: string | null;
  // Page-detected content kind (Task #650: audio/opinion), set at enrichment.
  // The badge reconciles this with URL shape and explicit title labels via
  // getEffectiveContentKindWithTitle
  // so the same signal that drove server-side filtering also drives display.
  contentKind?: string | null;
  category: string;
  // Content-based geography from the server (the article's SUBJECT geography,
  // never the outlet's origin). `country` is the single dominant country when one
  // clearly dominates; otherwise null and the broader `region` is shown. Both are
  // null for main-feed-sourced rows → the client falls back to a text heuristic.
  region: string | null;
  country: string | null;
  // Controlled-vocabulary classification ENRICHMENT object (Task #336). The
  // free-form `category` above stays the SPECIFIC card label; `primaryTopic` is
  // the overarching BUCKET used for grouping/filtering + manual assignment (it
  // is NOT the card label). `conflictTrack` drives an optional chip; `scope` and
  // the outlet provenance fields are display/labeling metadata. All optional.
  primaryTopic?: string | null;
  scope?: string | null;
  conflictTrack?: string | null;
  // Two FULL country names for a bilateral story (Topic·Focus model, Task #336).
  // The ONLY source for a non-conflict two-country Focus (e.g. "U.S.–Israel");
  // tracked-conflict pairs derive from `conflictTrack` at read time. The display
  // abbreviates + joins with an en-dash. Null when the story isn't bilateral.
  countryPair?: string[] | null;
  sourceKind?: string | null;
  outletOriginCountry?: string | null;
  outletOriginRegion?: string | null;
  outletOwnership?: string[] | null;
  source: string;
  url: string;
  clusterId: string | null;
  priorityScore: number;
  // Curated lane (Task #171) — allowlist-gated manual Priority override. When set
  // it is the pinned RAW P score; the server decays it by article age on the same
  // curve as every other curated row (NOT decay-exempt) before it reaches the
  // ranking and `priorityScore`. Applied in the Curated view ONLY. `rankingScore`
  // is the blend score (importance + corroboration boost) that actually orders the
  // feed — surfaced for the P-badge tooltip so allowlisted users can see this
  // story vs. the top-5/top-30 bars.
  priorityOverride?: number | null;
  rankingScore?: number;
  scrapedAt: string;
  articlePublishedAt: string | null;
  sourceCount: number;
  // Curated lane (Task #89) — story tier. 'contributing' = trusted source that
  // can FORM a story; 'attach-only' = adversary/opinion/low-cred/social.
  role: "contributing" | "attach-only";
  // Curated lane (Task #90) — synthesis layer. Populated ONLY for FORMED stories:
  // a short generalized headline, a neutral unbiased lede, and 2-3 facts
  // corroborated across DIVERSE contributing source types. Null for single-source
  // stories (which fall back to the article's own title/summary).
  headline?: string | null;
  lede?: string | null;
  facts?: string[] | null;
  // Curated lane (Task #256) — attributed claims / key statements. For single-
  // source rows these come from the article's own enrichment; for clusters from
  // the synthesis cache. Shown additively beneath the summary/facts; never folded
  // into Corroborated Facts (a claim is not a corroborated fact). Null/empty hides
  // the section.
  attributedClaims?: string[] | null;
  // Curated lane (Task #226) — dead-link flag. True ONLY for STANDALONE curated
  // rows whose article URL a liveness probe confirmed dead (404/410) with no
  // replacement overlay. The card shows a "link unavailable" state instead of
  // "Open article"; allowlisted users get a Replace control. Never set for
  // main-feed-sourced rows or formed clusters.
  linkDead?: boolean;
  // Cluster members embedded inline by /api/curated/top-stories, from the SAME
  // snapshot as this card's sourceCount/clusterId. When present, the detail
  // pop-out renders these directly instead of a separate by-clusterId fetch that
  // can go stale after a re-cluster wipes+rewrites the members table (the cause
  // of "30 sources" header vs "1 contributing source" body). Absent for
  // standalone single-source stories.
  members?: ClusterMember[];
  // Client-only optimistic flag (Task #746). Stamped on the primary card by the
  // link/merge onMutate handlers so the card can show a "Grouping…" indicator
  // while the server round-trip + deterministic reshape is in flight. Never sent
  // by the server, so it disappears automatically once the query re-fetches the
  // real merged card — preventing a visible flicker back to separate cards.
  _grouping?: boolean;
  // Editor HIDE flag (Task #380) — true when this story is currently hidden from
  // the Curated view. The read path FILTERS hidden stories out of the rendered
  // list, so this is effectively always false here; surfaced for type parity with
  // the endpoint payload and so the detail HIDE control can reflect state.
  hidden?: boolean;
  // Editor HIDE-photo overlay (Task #380 expansion) — the raw cluster member
  // photo candidates that are currently hidden (member-photo set ∩ the curated
  // hidden-images overlay). Powers the detail "Hidden photos" un-hide strip.
  // Clusters only; empty/absent for single-source rows.
  hiddenImages?: string[] | null;
  // Personal keyword watchlist (Task #456) — the watched substrings this story's
  // text matched. Set ONLY on rows returned by /api/curated/keyword-matches (and
  // copied onto a faceted card when a keyword also matched it) so the custom-feed
  // card can show a "matched: <kw>" badge. Never present on the main curated feed.
  matchedKeywords?: string[];
  // Curated-only editor HEADLINE + BULLETS overlay (Task #176). When a manual
  // correction has been saved for this story, this field mirrors the stored
  // override values so the editing control can show "already overridden" state
  // and offer a "reset to original" action. Null = no override active.
  // provenance: 'human' = editor-set (#176); 'auto' = system-recovered headline
  // from the paywall/CPC bypass during enrichment. Absent on older payloads.
  headlineOverride?: { headline: string | null; bullets: string[] | null; claims?: string[] | null; provenance?: string } | null;
}

// Top Narratives entry (left column). One INDIVIDUAL article ranked by its own
// priority within its media-ecosystem bucket (US domestic vs. international,
// decided by the PUBLISHING outlet's registry class — which press corps is
// carrying the story, never the story's subject geography).
// `sourceCount` is the cluster total when the article belongs to a cluster, else 1.
interface NarrativeItem {
  id: string;
  type: "scraped" | "manual" | "curated";
  title: string;
  source: string;
  url: string;
  category: string;
  priorityScore: number;
  sourceCount: number;
  clusterId: string | null;
  articlePublishedAt: string | null;
  scrapedAt: string;
  // Curated-lane enrichment surfaced for the State-controlled Narratives lens
  // (Task #450 follow-up). These are the SAME already-stored CPC paywall-breaker
  // + AI summary fields the cluster detail's ContrastSourceRow renders — never a
  // live fetch. Optional: a row that hasn't been enriched yet simply omits them.
  summary?: string | null;
  summaryBullets?: string[] | null;
  // Controlled-vocabulary classification carried from the curated overlay so the
  // opened story detail shows the SAME Topic·Focus the rest of the curated view
  // uses (e.g. "Force Posture · Israel") instead of the free-form category or the
  // outlet's origin country. Geography here is the story SUBJECT, never the outlet.
  primaryTopic?: string | null;
  conflictTrack?: string | null;
  region?: string | null;
  country?: string | null;
  countryPair?: string[] | null;
  // Dead-link overlay (Task #630) — mirrors the Top Stories treatment. When
  // true, `url` has NO healed replacement and points at a probe-confirmed
  // dead page; the row must never render as a normal clickable link. When a
  // replacement exists, `url` is already swapped to it server-side and this
  // stays false.
  linkDead?: boolean;
}

// State-controlled Narratives lens (Task #450). One adversary country's bucket
// of STATE-MEDIA articles (already priority-ranked). `count` is the full bucket
// size (the per-country payload is capped); `latestAt` is the freshest item's
// timestamp — both feed the volume/recency readout.
interface StateNarrativeCountry {
  country: string;
  items: NarrativeItem[];
  count: number;
  latestAt: string | null;
}

// "Emerging" pick for the MCOP Highlights section. Given a bucket's narrative
// items (already priority-ranked, so index 0 is the top headline), surface a
// DIFFERENT story that is breaking or gaining traction: prefer the most-recent
// item whose coverage is multiplying (sourceCount > 1 = gaining traction); if
// none is multi-source, fall back to the single most-recent remaining item.
// Returns null when there is no second story to show.
function pickEmerging(items: NarrativeItem[]): NarrativeItem | null {
  if (items.length <= 1) return null;
  const rest = items.slice(1);
  const ts = (it: NarrativeItem) =>
    new Date(it.articlePublishedAt || it.scrapedAt).getTime() || 0;
  const multi = rest.filter((it) => it.sourceCount > 1);
  const pool = multi.length > 0 ? multi : rest;
  return pool.reduce((best, it) => (ts(it) > ts(best) ? it : best), pool[0]);
}

// Stable empty references so the query's `?? fallback` doesn't churn identity
// each render (keeps the filteredStories memo from recomputing needlessly).
const EMPTY_STORIES: CuratedStory[] = [];
const EMPTY_NARRATIVES: { domestic: NarrativeItem[]; international: NarrativeItem[] } = {
  domestic: [],
  international: [],
};
const EMPTY_STATE_NARRATIVES: StateNarrativeCountry[] = [];

// Editor HIDE overlay (Task #380) — lightweight summary of a hidden story for
// the allowlist-gated "Hidden stories" review/un-hide panel. Mirrors the
// hiddenStories array the curated top-stories endpoint returns.
interface HiddenStorySummary {
  id: string;
  type: "scraped" | "manual" | "curated";
  clusterId: string | null;
  title: string;
  source: string;
  sourceCount: number;
  scrapedAt: string;
  articlePublishedAt: string | null;
  // Article URL — lets the panel hyperlink the title for a quick source check
  // before deciding to un-hide.
  url?: string | null;
  // The stored hidden-row key(s) the server deletes on un-hide. Carried straight
  // from the payload so un-hide restores the right row(s) even after the story's
  // cluster identity churned (otherwise a reconstructed key may not match).
  hiddenRecordKeys?: string[];
}
const EMPTY_HIDDEN_STORIES: HiddenStorySummary[] = [];

// Task #336 (Topic·Focus model): the curated card's TOPIC slot shows the SHORT
// bucket UI label for the controlled-vocabulary `primaryTopic` (e.g. "Military
// Ops", "Diplomacy", "Maritime Security"). `conflict_track` NEVER occupies the
// Topic slot — it only informs the Focus.
//
// ALLOWLIST MODEL (Task #912): the Topic slot may ONLY ever render (a) a
// controlled-vocabulary short label, or (b) a read-time keyword-INFERRED real
// topic (itself controlled-vocab), else the neutral dash. The free-form
// AI-authored `category` string is NEVER rendered raw here — previously it was
// a verbatim fallback guarded only by a denylist of known-junk phrases, so any
// novel hallucinated category (e.g. "Cultural Initiative") leaked straight into
// the Topic slot. `category` still feeds the Focus/subject slot elsewhere
// (unchanged) and still serves as inference TEXT below — it just can't be
// displayed as the Topic itself.
function storyTopicLabel(s: { primaryTopic?: string | null; category: string; title?: string | null; displayTitle?: string | null }): string {
  const short = primaryTopicShortLabel(s.primaryTopic);
  if (short) return short;
  // No SHORT controlled label. Take a conservative, display-only keyword guess
  // from the headline (returns a REAL controlled-vocab topic or null, never
  // junk or a conflict track) — but ONLY for a genuinely UNCLASSIFIED row (no
  // stored primary_topic at all). An explicit stored catch-all
  // ('Other / Emerging') is a real classifier/human decision and must keep
  // winning, so it falls through to "—" rather than being overridden by a guess.
  if (!s.primaryTopic?.trim()) {
    const inferred = primaryTopicShortLabel(inferPrimaryTopic(s.title, s.displayTitle, s.category));
    if (inferred) return inferred;
  }
  // Never surface a raw free-form category, "Other / Emerging", or a stale
  // bucket word as the Topic — fall through to the neutral dash.
  return "—";
}

// FALLBACK ONLY: main-feed-sourced rows don't carry a server-classified
// geography. We approximate it by keyword-matching the headline against a
// predefined region list. Because it's derived (not a real stored
// classification), it is rendered in the yellow placeholder style. Curated-store
// rows instead carry a real content-based region/country and skip this path.
const REGION_KEYWORDS: { region: string; keywords: string[] }[] = [
  { region: "Venezuela", keywords: ["venezuela", "maduro", "caracas"] },
  { region: "Greenland", keywords: ["greenland", "nuuk"] },
  { region: "Iran", keywords: ["iran", "tehran", "khamenei", "irgc", "iranian"] },
  { region: "Israel", keywords: ["israel", "israeli", "gaza", "netanyahu", "idf", "hamas", "hezbollah", "jerusalem", "tel aviv"] },
  { region: "Russia / Ukraine", keywords: ["russia", "russian", "ukraine", "ukrainian", "putin", "zelensky", "moscow", "kyiv", "kremlin"] },
  { region: "China", keywords: ["china", "chinese", "beijing", "taiwan", "xi jinping", "pla", "indo-pacific", "south china sea"] },
  { region: "India", keywords: ["india", "indian", "new delhi", "modi"] },
  { region: "Mexico / South America", keywords: ["mexico", "mexican", "brazil", "colombia", "argentina", "cartel", "south america", "latin america"] },
  { region: "Africa", keywords: ["africa", "african", "sahel", "nigeria", "sudan", "somalia", "ethiopia", "libya"] },
  { region: "Arctic", keywords: ["arctic", "north pole"] },
  { region: "Middle East", keywords: ["middle east", "saudi", "syria", "iraq", "yemen", "qatar", "houthi", "lebanon", "gulf"] },
  { region: "Europe", keywords: ["europe", "european", "nato", "germany", "france", "britain", "british", "uk ", "poland", "brussels", "eu "] },
  { region: "Domestic", keywords: ["homeland", "national guard", "washington", "white house", "congress", "pentagon"] },
];

// Heuristic region guess from the story text. This is a best-effort placeholder
// (flagged with <DemoTag/>) used only when the server didn't classify a
// content-based geography for the row (i.e. main-feed-sourced items).
function regionHeuristic(s: CuratedStory): string {
  const hay = `${s.title || ""} ${s.summary || ""}`.toLowerCase();
  for (const { region, keywords } of REGION_KEYWORDS) {
    if (keywords.some((kw) => hay.includes(kw))) return region;
  }
  return "—";
}

// Curated lane — non-article coverage. VIDEO / OPINION items (detected purely
// from their URL path, e.g. aljazeera.com/video/..., a /opinion/ column) are
// shown with a type badge and WITHOUT the full lede so they read as visibly
// distinct from regular reported articles. Classification lives in
// @shared/contentKind so the server filters/representative-picking and this badge
// can never drift apart.

// A small, non-interactive pill flagging a non-article item (video / opinion).
// Returns null for plain articles so the common case stays uncluttered.
function ContentKindBadge({ kind }: { kind: ContentKind | "audio" }) {
  if (kind === "video") {
    return (
      <Badge variant="secondary" className="gap-1" data-testid="badge-content-video">
        <Film className="h-3 w-3" /> Video
      </Badge>
    );
  }
  if (kind === "opinion") {
    return (
      <Badge variant="secondary" className="gap-1" data-testid="badge-content-opinion">
        <MessageSquareQuote className="h-3 w-3" /> Opinion
      </Badge>
    );
  }
  if (kind === "explainer") {
    return (
      <Badge variant="secondary" className="gap-1" data-testid="badge-content-explainer">
        <BookOpen className="h-3 w-3" /> Explainer
      </Badge>
    );
  }
  if (kind === "live") {
    return (
      <Badge variant="secondary" className="gap-1" data-testid="badge-content-live">
        <Radio className="h-3 w-3" /> Live
      </Badge>
    );
  }
  if (kind === "podcast") {
    return (
      <Badge variant="secondary" className="gap-1" data-testid="badge-content-podcast">
        <Headphones className="h-3 w-3" /> Podcast
      </Badge>
    );
  }
  return null;
}

// Resolve the geography label for a story. Geography reflects the ARTICLE
// CONTENT, never the outlet's origin. Preference order:
//   1. server-classified dominant country (most specific, real classification)
//   2. server-classified broader region (real classification)
//   3. keyword heuristic over the story text (placeholder, demo-tagged)
// Compact a few long geography labels so the metadata line stays short and can
// sit on a single row (e.g. "United States" -> "U.S.", "United Kingdom" -> "UK").
// Only abbreviates the fully-unambiguous full names; every other label passes
// through untouched.
// Display-only: callers that DETECT domestic stories test the raw `s.country`,
// so this never affects classification/bucketing.
function abbreviateGeo(label: string): string {
  const t = label.trim();
  if (/^(the\s+)?united states(\s+of\s+america)?$/i.test(t)) return "U.S.";
  if (/^u\.?\s*s\.?\s*a?\.?$/i.test(t)) return "U.S.";
  if (/^(the\s+)?united kingdom(\s+of\s+great\s+britain(\s+and\s+northern\s+ireland)?)?$/i.test(t)) return "UK";
  if (/^u\.?\s*k\.?$/i.test(t)) return "UK";
  return t;
}

function resolveRegion(s: CuratedStory): { region: string; isPlaceholder: boolean } {
  if (s.country && s.country.trim()) {
    return { region: abbreviateGeo(s.country.trim()), isPlaceholder: false };
  }
  if (s.region && s.region.trim()) {
    return { region: abbreviateGeo(s.region.trim()), isPlaceholder: false };
  }
  return { region: abbreviateGeo(regionHeuristic(s)), isPlaceholder: true };
}

// Format a two-country Focus pair: abbreviate each name (United States -> U.S.)
// and join with an EN-DASH (U+2013), e.g. "U.S.–Iran", "Russia–Ukraine".
function formatGeoPair(pair: readonly string[]): string {
  return `${abbreviateGeo(pair[0].trim())}\u2013${abbreviateGeo(pair[1].trim())}`;
}

// Task #336 (Topic·Focus model): resolve the curated card's FOCUS slot — a single
// country, a region, a two-country pair, or "Global". This REPLACES the bare
// geography label in the card/detail metadata. Geography reflects the ARTICLE
// CONTENT, never the outlet's origin. Preference order:
//   1. an explicit stored two-country pair (the only source for a NON-conflict
//      bilateral focus, e.g. "U.S.–Israel")
//   2. the tracked-conflict focus (a pair like "Russia–Ukraine", or a theater
//      label like "Gaza"/"Red Sea") — free for historical/marquee rows
//   3. the single dominant country (real server classification)
//   4. the broader region (real server classification)
//   5. a deterministic content-based focus inference over the story text
//      (foreign theaters + a first-class U.S./domestic focus) — a REAL
//      derivation, NOT demo-tagged
//   6. "Global" as the last-resort fallback for a genuinely global / unresolved
//      story — a legitimate real label, also NOT demo-tagged
// The DEMO marker is reserved for true placeholder (dummy) surfaces, so a real
// curated story NEVER renders "Global · DEMO": focusLabel always returns
// isPlaceholder=false. resolveRegion (above) is left untouched — the broad-region
// facet still uses its own keyword heuristic.
function focusLabel(s: CuratedStory): { label: string; isPlaceholder: boolean } {
  const pair = s.countryPair;
  if (Array.isArray(pair) && pair.length === 2 && pair[0]?.trim() && pair[1]?.trim()) {
    return { label: formatGeoPair(pair), isPlaceholder: false };
  }
  const track = s.conflictTrack?.trim();
  if (track) {
    const f = (CONFLICT_TRACK_FOCUS as Record<string, { countries?: [string, string]; label?: string }>)[track];
    if (f?.countries) return { label: formatGeoPair(f.countries), isPlaceholder: false };
    if (f?.label) return { label: f.label, isPlaceholder: false };
  }
  if (s.country && s.country.trim()) {
    return { label: abbreviateGeo(s.country.trim()), isPlaceholder: false };
  }
  if (s.region && s.region.trim()) {
    return { label: abbreviateGeo(s.region.trim()), isPlaceholder: false };
  }
  // Deterministic content-based focus from the headline/summary (read-time
  // fallback for a row the overlay hasn't classified yet). Catches foreign
  // theaters AND a first-class U.S./domestic focus, so an unclassified-but-real
  // story shows a meaningful Focus instead of "Global". This is a REAL
  // derivation, not dummy data, so it is NOT demo-tagged.
  const inferred = inferFocus(s.title, (s as any).displayTitle, s.summary);
  if (inferred) return { label: abbreviateGeo(inferred), isPlaceholder: false };
  // Last resort: a genuinely global / unresolved real story. "Global" is a
  // legitimate label for real content, so it is NOT demo-tagged either — the
  // DEMO marker is reserved for true placeholder (dummy) surfaces, never real
  // curated content.
  return { label: "Global", isPlaceholder: false };
}

// -----------------------------------------------------------------------------
// BROAD REGION bucketing for the "Subject Region" facet (Custom Feed only).
// The card/detail geography label (resolveRegion above) intentionally shows the
// most SPECIFIC country, so countries leak into a region facet built from it.
// The facet should instead show only BROAD geographic regions and let a country
// like "Israel" count toward "Middle East" — never appear as its own region.
// The per-card label is unaffected; this path is used solely for the facet.
// -----------------------------------------------------------------------------

// The canonical broad regions the AI classifier emits for `region`, plus the
// few extra theatres it uses. The facet must only ever surface these names.
const BROAD_REGIONS: readonly string[] = [
  "Middle East",
  "Europe",
  "Indo-Pacific",
  "North America",
  "Latin America",
  "Africa",
  "Central Asia",
  "Arctic",
  "Red Sea",
  "Persian Gulf",
  "Korean Peninsula",
  "South China Sea",
  "Global",
];

// Map a country name — OR a country-named heuristic bucket (e.g. "Russia /
// Ukraine", "Mexico / South America") — to its broad region. Keys are
// lowercased; lookups normalize first. Anything not present falls back to the
// story's broad `region` classification or "Global".
const COUNTRY_TO_BROAD_REGION: Record<string, string> = {
  // --- Broad-region ALIASES (some AI rows put a near-region in `region`) ------
  "asia": "Indo-Pacific",
  "south asia": "Indo-Pacific",
  "southeast asia": "Indo-Pacific",
  "east asia": "Indo-Pacific",
  "caribbean": "Latin America",
  "south america": "Latin America",
  "central america": "Latin America",
  "caucasus": "Europe",
  "balkans": "Europe",
  "european union": "Europe",
  "domestic": "North America",
  // Middle East
  "israel": "Middle East",
  "gaza": "Middle East",
  "palestine": "Middle East",
  "west bank": "Middle East",
  "iran": "Middle East",
  "lebanon": "Middle East",
  "syria": "Middle East",
  "iraq": "Middle East",
  "yemen": "Middle East",
  "saudi arabia": "Middle East",
  "qatar": "Middle East",
  "jordan": "Middle East",
  "egypt": "Middle East",
  "turkey": "Middle East",
  "uae": "Middle East",
  "united arab emirates": "Middle East",
  "bahrain": "Middle East",
  "oman": "Middle East",
  "kuwait": "Middle East",
  // Europe
  "ukraine": "Europe",
  "russia": "Europe",
  "russia / ukraine": "Europe",
  "france": "Europe",
  "united kingdom": "Europe",
  "uk": "Europe",
  "britain": "Europe",
  "germany": "Europe",
  "poland": "Europe",
  "bulgaria": "Europe",
  "armenia": "Europe",
  "azerbaijan": "Europe",
  "georgia": "Europe",
  "italy": "Europe",
  "spain": "Europe",
  "greece": "Europe",
  "romania": "Europe",
  "finland": "Europe",
  "sweden": "Europe",
  "norway": "Europe",
  "denmark": "Europe",
  "netherlands": "Europe",
  "belgium": "Europe",
  "austria": "Europe",
  "switzerland": "Europe",
  "portugal": "Europe",
  "ireland": "Europe",
  "serbia": "Europe",
  "kosovo": "Europe",
  "albania": "Europe",
  "croatia": "Europe",
  "slovenia": "Europe",
  "slovakia": "Europe",
  "czech republic": "Europe",
  "czechia": "Europe",
  "hungary": "Europe",
  "moldova": "Europe",
  "belarus": "Europe",
  "latvia": "Europe",
  "lithuania": "Europe",
  "estonia": "Europe",
  "malta": "Europe",
  "cyprus": "Europe",
  // Indo-Pacific / Asia
  "china": "Indo-Pacific",
  "taiwan": "Indo-Pacific",
  "japan": "Indo-Pacific",
  "philippines": "Indo-Pacific",
  "australia": "Indo-Pacific",
  "new zealand": "Indo-Pacific",
  "india": "Indo-Pacific",
  "pakistan": "Indo-Pacific",
  "afghanistan": "Indo-Pacific",
  "bangladesh": "Indo-Pacific",
  "sri lanka": "Indo-Pacific",
  "nepal": "Indo-Pacific",
  "indonesia": "Indo-Pacific",
  "vietnam": "Indo-Pacific",
  "thailand": "Indo-Pacific",
  "malaysia": "Indo-Pacific",
  "singapore": "Indo-Pacific",
  "brunei": "Indo-Pacific",
  "myanmar": "Indo-Pacific",
  "north korea": "Korean Peninsula",
  "south korea": "Korean Peninsula",
  // Central Asia
  "kazakhstan": "Central Asia",
  "uzbekistan": "Central Asia",
  "tajikistan": "Central Asia",
  "kyrgyzstan": "Central Asia",
  "turkmenistan": "Central Asia",
  // North America
  "united states": "North America",
  "usa": "North America",
  "u.s.": "North America",
  "us": "North America",
  "canada": "North America",
  "greenland": "Arctic",
  // Latin America
  "mexico": "Latin America",
  "mexico / south america": "Latin America",
  "brazil": "Latin America",
  "peru": "Latin America",
  "venezuela": "Latin America",
  "colombia": "Latin America",
  "argentina": "Latin America",
  "chile": "Latin America",
  "cuba": "Latin America",
  "panama": "Latin America",
  "bolivia": "Latin America",
  "nicaragua": "Latin America",
  "ecuador": "Latin America",
  "guatemala": "Latin America",
  "honduras": "Latin America",
  "uruguay": "Latin America",
  "paraguay": "Latin America",
  // Africa
  "nigeria": "Africa",
  "kenya": "Africa",
  "sudan": "Africa",
  "somalia": "Africa",
  "ethiopia": "Africa",
  "libya": "Africa",
  "south africa": "Africa",
  "mali": "Africa",
  "niger": "Africa",
  "congo": "Africa",
  "democratic republic of the congo": "Africa",
  "algeria": "Africa",
  "morocco": "Africa",
  "tunisia": "Africa",
  "uganda": "Africa",
  "botswana": "Africa",
  "tanzania": "Africa",
  "ghana": "Africa",
  "chad": "Africa",
  "burkina faso": "Africa",
  "rwanda": "Africa",
  "zimbabwe": "Africa",
  "mozambique": "Africa",
};

// Normalize any geography label (a broad region, a country, or a country-named
// heuristic bucket) to a single BROAD region, or null if it can't be resolved.
function toBroadRegion(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed === "—") return null;
  const lc = trimmed.toLowerCase();
  // Already a canonical broad region — return its canonical spelling.
  const canonical = BROAD_REGIONS.find((r) => r.toLowerCase() === lc);
  if (canonical) return canonical;
  // Otherwise map a country / country-named bucket to its broad region.
  return COUNTRY_TO_BROAD_REGION[lc] ?? null;
}

// The geography value used by the "Subject Region" facet. Preference order:
//   1. the story's broad `region` classification (already broad)
//   2. the dominant `country` mapped to its broad region
//   3. the keyword heuristic, mapped to its broad region
// Never returns a bare country name — only a broad region (or null).
function resolveBroadRegion(s: CuratedStory): string | null {
  return (
    toBroadRegion(s.region) ??
    toBroadRegion(s.country) ??
    toBroadRegion(regionHeuristic(s))
  );
}

// -----------------------------------------------------------------------------
// COUNTRY COVERED facet vocabulary. The classifier tags each story with a
// free-form content `country` (any name allowed), so the only bounded "could be"
// set is the roster of countries MCOP already recognizes — the keys of
// COUNTRY_TO_BROAD_REGION above. We derive a clean, de-duplicated display list
// from it so the Country Covered facet can offer every tracked country (each at
// count 0 until a story matches), and canonicalize each story's raw country to
// the same display name so live values and seeded values merge cleanly.
// -----------------------------------------------------------------------------

// Proper display names where a plain Title-Case of the key is wrong, or where
// several spellings fold to one canonical country.
const COUNTRY_DISPLAY_OVERRIDES: Record<string, string> = {
  "usa": "United States",
  "u.s.": "United States",
  "us": "United States",
  "united states": "United States",
  "uk": "United Kingdom",
  "britain": "United Kingdom",
  "united kingdom": "United Kingdom",
  "uae": "United Arab Emirates",
  "united arab emirates": "United Arab Emirates",
  "democratic republic of the congo": "Democratic Republic of the Congo",
  "czechia": "Czech Republic",
  "czech republic": "Czech Republic",
};

// Region-map keys that are NOT single countries (broad-region aliases, multi-
// country buckets, or sub-national territories) — kept out of the seeded list.
const NON_COUNTRY_GEO_KEYS = new Set<string>([
  "asia", "south asia", "southeast asia", "east asia", "caribbean",
  "south america", "central america", "caucasus", "balkans",
  "european union", "domestic", "russia / ukraine", "mexico / south america",
  "gaza", "west bank",
]);

function normGeoKey(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function titleCaseGeo(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function countryDisplayName(rawKey: string): string {
  const k = rawKey.trim().toLowerCase();
  return COUNTRY_DISPLAY_OVERRIDES[k] ?? titleCaseGeo(k);
}

// Normalized spelling -> canonical display name, covering every recognized key
// (including abbreviations) so a live `country` value folds to the seeded label.
const COUNTRY_DISPLAY_BY_NORM = new Map<string, string>();
for (const key of Object.keys(COUNTRY_TO_BROAD_REGION)) {
  if (NON_COUNTRY_GEO_KEYS.has(key)) continue;
  COUNTRY_DISPLAY_BY_NORM.set(normGeoKey(key), countryDisplayName(key));
}

// The bounded "could be" roster for the Country Covered facet.
const TRACKED_COUNTRIES: readonly string[] = Array.from(
  new Set(COUNTRY_DISPLAY_BY_NORM.values()),
).sort((a, b) => a.localeCompare(b));

// Canonicalize a story's free-form content country to its display name so live
// values merge with the seeded vocabulary; unknown countries pass through as-is.
function canonicalCountry(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  return COUNTRY_DISPLAY_BY_NORM.get(normGeoKey(raw)) ?? raw.trim();
}

// -----------------------------------------------------------------------------
// Custom Feed category GROUPING. The server tags each story with a PRECISE topic
// (e.g. "US-Iran Relations", "Gaza Conflict", "Semiconductor Economics"). Left
// raw, the picker shows ~60 tiny one-story categories. Here we fold those precise
// topics into a small set of OVERARCHING macro-categories so the picker offers
// bulky, meaningful choices. A story can belong to MORE THAN ONE macro (e.g.
// "China-US Relations" → both "U.S. Foreign Policy" and "China & Indo-Pacific").
// Matching is keyword-based so brand-new precise topics from the AI still bucket
// sensibly; anything unmatched falls back to "Other". The per-card category
// badges still show the precise topic — only the Custom Feed picker groups.
function macroCategoriesFor(raw: string | null | undefined): string[] {
  const lc = (raw ?? "").toLowerCase();
  if (!lc.trim()) return [];
  const out = new Set<string>();
  const has = (...needles: string[]) => needles.some((n) => lc.includes(n));
  const usRef =
    /\bu\.?\s?s\.?\b/.test(lc) ||
    has("united states", "american", "washington", "white house", "pentagon", "state department", "trump");

  // Actor / regional buckets ------------------------------------------------
  if (has("israel", "gaza", "palestin", "hamas", "hezbollah", "idf", "netanyahu", "jerusalem", "west bank"))
    out.add("Israel Relations");
  if (has("iran", "tehran", "irgc", "khamenei"))
    out.add("Iran");
  if (has("china", "chinese", "taiwan", "beijing", "south china sea", "indo-pacific", "north korea", "pyongyang", "korea"))
    out.add("China & Indo-Pacific");
  if (has("ukraine", "ukrainian", "russia", "russian", "putin", "zelensky", "moscow", "kyiv", "kremlin"))
    out.add("Russia & Ukraine");
  if (has("nato", "europe", "european", "eu-", "eu ", "france", "french", "german", "britain", "british", "armenia", "poland", "brussels"))
    out.add("Europe & NATO");
  if (has("afghan", "taliban"))
    out.add("Afghanistan");
  if (has("africa", "african", "nigeria", "sahel", "kenya", "south africa", "borno", "somalia", "sudan", "ethiopia", "libya"))
    out.add("Africa");
  if (has("middle east", "saudi", "syria", "iraq", "yemen", "houthi", "lebanon", "qatar", "gulf"))
    out.add("Middle East");

  // Thematic buckets --------------------------------------------------------
  if (has("econom", "trade", "tariff", "sanction", "financ", "market", "currency", "supply chain", "fiscal"))
    out.add("Economics & Trade");
  if (has("energy", "oil", " gas", "natural gas", "pipeline", "electric", "power grid", "lng"))
    out.add("Global Energy");
  if (has("nuclear weapon", "nuclear program", "nuclear arms", "wmd", "ballistic", "missile", "chemical weapon", "enrichment", "warhead"))
    out.add("Nuclear & WMD");
  if (has("artificial intelligence", "ai ", "ai-", "ai and", "ai technology", "space", "semiconductor", "technolog", "cyber", "drone", "hypersonic", "defense collaboration"))
    out.add("Defense Technology");
  if (has("information warfare", "information environment", "disinformation", "misinformation", "propaganda", "narrative", "influence operation"))
    out.add("Information Environment");
  if (has("humanitarian", "refugee", "famine", "human rights", "civil rights", "displacement", "protest", "unrest"))
    out.add("Humanitarian & Human Rights");
  if (has("border", "immigration", "visa", "domestic terror", "trafficking", "homeland", "drug", "cartel", "judiciary"))
    out.add("Homeland & Border Security");
  if (
    has("military", "troop", "deployment", "combat", "warfare", "strike", "counterterror",
      "armed forces", " navy", "air force", " army", "global security", "national security", "international security") &&
    !has("information warfare")
  )
    out.add("Military Operations");

  // U.S. Foreign Policy: a US bilateral / diplomatic story that ISN'T mainly a
  // shooting conflict (those land in the conflict/actor buckets above). Per the
  // requested behavior, "US-Iran Relations" → foreign policy, but "US-Iran
  // Conflict" stays in the conflict / Iran buckets.
  const isRelations = has("relations", "diplomacy", "ties", "alliance", "summit", "foreign policy", "accord", "treaty", "negotiation");
  if ((isRelations && usRef) || has("us foreign policy", "u.s. foreign policy", "un diplomacy", "sanctions diplomacy"))
    out.add("U.S. Foreign Policy");

  if (out.size === 0) out.add("Other");
  return Array.from(out);
}

// -----------------------------------------------------------------------------
// CUSTOM FEED — a user-built, persisted feed driven by multi-select metadata
// filters ("What do you want to see?"). The user picks values across several
// metadata dimensions; stories matching the selection render as a horizontal
// card row. Selections persist in localStorage like the header feed toggles.
// -----------------------------------------------------------------------------

// v3 adds tri-state (include/exclude) facets, a Format facet, and a Time window
// threshold. The old v2 shape (plain string[] per dimension) is migrated on load.
const CUSTOM_FEED_STORAGE_KEY = "mcop-curated-custom-feed-v3";
const CUSTOM_FEED_STORAGE_KEY_LEGACY = "mcop-curated-custom-feed-v2";
const CUSTOM_FEED_VIEWS_KEY = "mcop-curated-custom-feed-views-v1";
// Personal keyword watchlist (Task #456) — ADDITIVE union recall. Persisted
// per-browser; curated custom-feed section only.
const CUSTOM_FEED_KEYWORDS_KEY = "mcop-curated-custom-feed-keywords-v1";

// Friendly Title-Case for the factuality tokens stored on the outlet registry.
function reliabilityLabel(f: string): string {
  return f
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// The metadata MCOP knows about each story, flattened into the dimensions the
// Custom Feed lets users filter on. The COVERED geography (region/country) is the
// article's content geography; the SOURCE geography is the outlet's home base.
// Reliability is the outlet's factuality rating; scope buckets the covered
// geography into U.S. Domestic vs International. Format is derived from the URL.
interface CustomFeedMeta {
  // Macro categories the story belongs to (a story can match several). All other
  // dimensions are single-valued.
  category: string[];
  region: string | null;
  country: string | null;
  format: string | null;
  originRegion: string | null;
  originCountry: string | null;
  reliability: string | null;
  scope: string | null;
  // Published-or-first-seen time (epoch ms) for the Time window threshold. Not a
  // chip facet — handled separately from CUSTOM_FEED_DIMENSIONS.
  publishedMs: number | null;
}

// Title-Case the URL-derived content kind for the Format facet.
function formatLabel(kind: ContentKind | "audio"): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

// Narrow a raw stored content_kind string (server persists arbitrary text) down
// to the StoredContentKind union so it can be passed to the shared content-kind
// resolvers. Any unrecognized value collapses to null (treated as a plain
// article), matching the server contract.
function toStoredContentKind(raw: string | null | undefined): StoredContentKind {
  if (raw === "audio" || raw === "article" || raw === "opinion" || raw === "explainer") {
    return raw;
  }
  return null;
}

function customFeedMetaForStory(
  s: CuratedStory,
  outletIndex: OutletIndex | null,
): CustomFeedMeta {
  const outlet = outletIndex ? findOutlet(outletIndex, s.source, s.url) : undefined;
  // The Region Covered facet uses BROAD regions only (countries fold into their
  // region). The scope/News Type heuristic keeps using the specific label so its
  // behavior is unchanged.
  const broadRegion = resolveBroadRegion(s);
  const specificRegion = resolveRegion(s).region;
  const country = canonicalCountry(s.country);
  const isDomestic =
    (country ? /united states|u\.?s\.?a?\b/i.test(country) : false) ||
    /domestic/i.test(specificRegion);
  const ts = s.articlePublishedAt || s.scrapedAt;
  const publishedMs = ts ? new Date(ts).getTime() : null;
  return {
    // Task #336: the Topic facet GROUPS by the controlled-vocabulary
    // primary_topic bucket (the card itself shows the more specific `category`).
    // Only rows not yet classified fall back to the legacy keyword bucketing.
    category: s.primaryTopic?.trim()
      ? [s.primaryTopic.trim()]
      : macroCategoriesFor(s.category),
    region: broadRegion,
    country,
    format: formatLabel(getEffectiveContentKindWithTitle(s.url, s.title, toStoredContentKind(s.contentKind))),
    originRegion: outlet?.originRegion ?? null,
    originCountry: outlet?.originCountry ?? null,
    reliability: outlet?.factuality ? reliabilityLabel(outlet.factuality) : null,
    scope: isDomestic ? "U.S. Domestic" : "International",
    publishedMs: publishedMs != null && Number.isFinite(publishedMs) ? publishedMs : null,
  };
}

// Only the chip-based facets (publishedMs is handled by the Time window).
type CustomFeedDimKey =
  | "scope"
  | "category"
  | "region"
  | "country"
  | "format"
  | "originRegion"
  | "originCountry"
  | "reliability";

type CustomFeedSection = "about" | "who";

// The dimensions, in display order, with their human labels and which captioned
// section they belong to. "about" = what the story is about; "who" = who reported
// it. Per-value lists longer than this stay scannable via an inline search box.
const CUSTOM_FEED_DIMENSIONS: {
  key: CustomFeedDimKey;
  label: string;
  section: CustomFeedSection;
}[] = [
  { key: "scope", label: "News Type", section: "about" },
  { key: "category", label: "Topic", section: "about" },
  { key: "region", label: "Region Covered", section: "about" },
  { key: "country", label: "Country Covered", section: "about" },
  { key: "format", label: "Format", section: "about" },
  { key: "originRegion", label: "Source Region", section: "who" },
  { key: "originCountry", label: "Source Country", section: "who" },
  { key: "reliability", label: "Source Reliability", section: "who" },
];

// Bounded controlled-vocabulary "could be" lists per facet. Seeding these into
// the option builder means the FULL menu shows even when nothing matches right
// now (each missing value renders at count 0, dimmed but still selectable).
// Only facets whose values are a closed, classifier-coerced set are listed —
// free-form facets are omitted so we never invent options the data can't
// actually produce.
const CUSTOM_FEED_VOCAB: Partial<Record<CustomFeedDimKey, readonly string[]>> = {
  category: PRIMARY_TOPICS,
  region: BROAD_REGIONS,
  country: TRACKED_COUNTRIES,
};

const CUSTOM_FEED_SECTIONS: { id: CustomFeedSection; label: string }[] = [
  { id: "about", label: "What the story is about" },
  { id: "who", label: "Who reported it" },
];

// Above this many options, a facet group renders an inline search box.
const CUSTOM_FEED_SEARCH_THRESHOLD = 12;

// Single-select recency buckets, applied as a threshold on publishedMs.
const CUSTOM_FEED_TIME_WINDOWS: { label: string; hours: number | null }[] = [
  { label: "Any time", hours: null },
  { label: "Last 6h", hours: 6 },
  { label: "Last 24h", hours: 24 },
  { label: "Last 3d", hours: 72 },
  { label: "Last 7d", hours: 168 },
];

// Tri-state per facet: a value can be included, excluded, or off (in neither).
interface FacetSelection {
  include: string[];
  exclude: string[];
}

interface CustomFeedSelection {
  facets: Partial<Record<CustomFeedDimKey, FacetSelection>>;
  // null = any time; otherwise the recency threshold in hours.
  timeWindowHours: number | null;
}

interface CustomFeedSavedView {
  id: string;
  name: string;
  selection: CustomFeedSelection;
}

function emptyCustomFeedSelection(): CustomFeedSelection {
  return { facets: {}, timeWindowHours: null };
}

// A story passes if, for EVERY facet the user constrains: it matches at least one
// INCLUDED value (when any are set) AND matches NONE of the excluded values. The
// Time window, when set, requires the story be newer than the threshold. (AND
// across dimensions, OR within a dimension's include list.)
function storyMatchesCustomFeed(
  meta: CustomFeedMeta,
  selection: CustomFeedSelection,
  nowMs: number,
): boolean {
  for (const { key } of CUSTOM_FEED_DIMENSIONS) {
    const sel = selection.facets[key];
    if (!sel || (sel.include.length === 0 && sel.exclude.length === 0)) continue;
    const raw = meta[key];
    const vals = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (sel.include.length > 0 && !vals.some((v) => sel.include.includes(v)))
      return false;
    if (sel.exclude.length > 0 && vals.some((v) => sel.exclude.includes(v)))
      return false;
  }
  if (selection.timeWindowHours != null) {
    if (meta.publishedMs == null) return false;
    if (meta.publishedMs < nowMs - selection.timeWindowHours * 3600_000)
      return false;
  }
  return true;
}

function customFeedSelectionCount(selection: CustomFeedSelection): number {
  let n = selection.timeWindowHours != null ? 1 : 0;
  for (const { key } of CUSTOM_FEED_DIMENSIONS) {
    const sel = selection.facets[key];
    if (sel) n += sel.include.length + sel.exclude.length;
  }
  return n;
}

// A copy of the selection with one facet's constraints removed — used for
// faceted (selection-aware) counting so each option's count reflects the rest
// of the current selection.
function customFeedSelectionWithout(
  selection: CustomFeedSelection,
  dropKey: CustomFeedDimKey,
): CustomFeedSelection {
  const facets = { ...selection.facets };
  delete facets[dropKey];
  return { facets, timeWindowHours: selection.timeWindowHours };
}

// Validate/coerce an unknown blob into the tri-state selection shape, also
// accepting the legacy v2 shape (plain string[] per dimension → include-only).
function coerceCustomFeedSelection(blob: unknown): CustomFeedSelection {
  const out = emptyCustomFeedSelection();
  if (!blob || typeof blob !== "object") return out;
  const obj = blob as Record<string, unknown>;
  const facetSource =
    obj.facets && typeof obj.facets === "object"
      ? (obj.facets as Record<string, unknown>)
      : obj; // legacy v2: dims sit at the top level
  const strs = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  for (const { key } of CUSTOM_FEED_DIMENSIONS) {
    const entry = facetSource[key];
    let include: string[] = [];
    let exclude: string[] = [];
    if (Array.isArray(entry)) {
      include = strs(entry); // legacy plain array
    } else if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      include = strs(e.include);
      exclude = strs(e.exclude);
    }
    if (include.length > 0 || exclude.length > 0) out.facets[key] = { include, exclude };
  }
  const tw = obj.timeWindowHours;
  if (
    typeof tw === "number" &&
    CUSTOM_FEED_TIME_WINDOWS.some((w) => w.hours === tw)
  ) {
    out.timeWindowHours = tw;
  }
  return out;
}

// Load + sanitize the persisted selection (drops malformed shapes; migrates v2).
function loadCustomFeedSelection(): CustomFeedSelection {
  try {
    const v3 = localStorage.getItem(CUSTOM_FEED_STORAGE_KEY);
    if (v3) return coerceCustomFeedSelection(JSON.parse(v3));
    const v2 = localStorage.getItem(CUSTOM_FEED_STORAGE_KEY_LEGACY);
    if (v2) return coerceCustomFeedSelection(JSON.parse(v2));
    return emptyCustomFeedSelection();
  } catch {
    return emptyCustomFeedSelection();
  }
}

function loadCustomFeedViews(): CustomFeedSavedView[] {
  try {
    const saved = localStorage.getItem(CUSTOM_FEED_VIEWS_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v) => v && typeof v === "object")
      .map((v) => ({
        id:
          typeof v.id === "string" && v.id
            ? v.id
            : `view-${Math.random().toString(36).slice(2)}`,
        name: typeof v.name === "string" ? v.name : "Untitled",
        selection: coerceCustomFeedSelection(v.selection),
      }))
      .filter((v) => customFeedSelectionCount(v.selection) > 0);
  } catch {
    return [];
  }
}

interface ClusterMember {
  id: string;
  title: string;
  // Display-only cleaned title (daily live-blog prefixes stripped); `title`
  // stays the original.
  displayTitle?: string | null;
  source: string;
  url: string;
  publishedAt: string;
  // Curated lane (Task #89) — legacy member tier (kept for the single-source
  // fallback row, which has no behavior class).
  role: "contributing" | "anchor-only" | "attach-only";
  // Display trust-tier (Task #121) — the behavior class+label stamped at
  // formation time, so the detail view can split corroborating / primary-origin /
  // contrast / attach. Absent on the synthesized single-source fallback row.
  behaviorClass?: "corroborating" | "anchor-only" | "attach";
  behaviorLabel?: "primary" | "contrast" | null;
  // Page-detected content kind (Task #650: audio/opinion), snapshotted at
  // formation time. Reconciled with URL shape and title labels via
  // getEffectiveContentKindWithTitle
  // so a member's badge matches the same signal that demoted it to attach.
  contentKind?: string | null;
  // Curated lane (Task #90) — one-sentence characterization of THIS outlet's
  // angle/spin on the story. Null until synthesis runs.
  spin?: string | null;
  // Per-contrast alignment breakdown (Task #121) — which of this contrast
  // source's claims ALIGN with the corroborated facts and which DIVERGE. Only
  // present for contrast members; null otherwise.
  alignment?: { align: string[]; diverge: string[]; pct?: number } | null;
  // Snapshot of this outlet's OWN standalone summary/lede at clustering time,
  // shown alongside the spin so a row conveys both what the article said and how
  // the outlet framed it.
  summary?: string | null;
  // Curated lane (Task #126) — this member's photo + 3-bullet AI summary, read
  // live from curated_items so expanded-story member rows match the standalone
  // and representative cards. Null when the source has no enriched media.
  ogImageUrl?: string | null;
  summaryBullets?: string[] | null;
  // Curated lane (Task #226) — the member's lane ('curated' vs 'main'); only
  // curated members can be link-flagged or replaced.
  itemType?: "curated" | "main";
  // Curated lane (Task #226) — dead-link flag for this member's URL (curated
  // members only). When set, the row shows a "link unavailable" state instead of
  // a click-through; allowlisted users get a Replace control.
  linkDead?: boolean;
}

function normalizeCuratedIdentityUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    const tracking =
      /^(utm_|at_|ns_)|^(maca|traffic_source|srnd|cmp|cmpid|ito|igshid|icid|fbclid|gclid|dclid|gclsrc|msclkid|yclid|mc_cid|mc_eid|ocid|spm|ref_src|ref_url|guccounter|__twitter_impression)$/i;
    const keys: string[] = [];
    url.searchParams.forEach((_value, key) => keys.push(key));
    for (const key of keys) {
      if (tracking.test(key)) url.searchParams.delete(key);
    }
    const kept: Array<[string, string]> = [];
    url.searchParams.forEach((value, key) => kept.push([key, value]));
    kept.sort(([a], [b]) => a.localeCompare(b));
    url.search = "";
    for (const [key, value] of kept) url.searchParams.append(key, value);
    return url.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return raw.trim().split("#", 1)[0].replace(/\/+$/, "").toLowerCase();
  }
}

function isSocialPostIdentityUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
    return host === "x.com" || host === "twitter.com" || host === "truthsocial.com";
  } catch {
    return false;
  }
}

function timeAgo(date: string | Date | null): string {
  if (!date) return "";
  const diffMs = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Social-style timestamp for the clustered/single story detail view. Wraps the
// shared `formatCuratedPostTime` so the threshold rule (minutes/hours ago, then
// clock time, then clock time + date for an earlier day) lives in ONE place and
// matches the X / Truth Social / First Alert feeds — computed in the viewer's
// selected timezone. These stamps sit inside an already "·"-delimited metadata
// line (each field renders as "· value"), so we pass a PLAIN-SPACE date
// separator: the earlier-day date reads "5:55 AM 15 Jun 26", never "5:55 AM ·
// 15 Jun 26" which would collide with the surrounding field dots. An optional
// label ("First seen", "Updated", "Published") is prefixed; null/empty dates
// render as empty, matching the prior behavior.
function formatDetailTime(
  date: string | Date | null,
  tz: string,
  prefix?: string,
): string {
  if (!date) return "";
  const stamp = formatCuratedPostTime(date, tz, true, " ");
  return prefix ? `${prefix} ${stamp}` : stamp;
}

// Article publication, MCOP first-seen, and cluster-update times have distinct
// provenance, but all must be absolute DTGs in detail view. This prevents a
// reader opening a story later from mistaking a relative stamp for its source
// publication time while keeping each label honest.
function formatDetailProvenanceTime(
  date: string | Date | null,
  tz: string,
  label: "Published" | "First seen" | "Updated",
): string {
  if (!date) return "";
  const stamp = formatCuratedPublicationDTG(date, tz);
  return stamp ? `${label} ${stamp}` : "";
}

// -----------------------------------------------------------------------------
// Curated header (self-contained — does not touch the shared classic Header so
// main MCOP behavior is untouched).
// -----------------------------------------------------------------------------
interface CuratedHeaderProps {
  autoRefresh: boolean;
  onAutoRefreshChange: (v: boolean) => void;
  onManualRefresh: () => void;
  isRefreshing: boolean;
  search: string;
  onSearchChange: (v: string) => void;
  showSearchBar: boolean;
  showMcopBot: boolean;
  // Editor "view as public" toggle (Task #380 expansion). canModerate gates the
  // pill on REAL allowlist access (the PAGE gate is unchanged); previewAsPublic is
  // the live client state; onTogglePreviewAsPublic flips it instantly (no reload).
  canModerate: boolean;
  previewAsPublic: boolean;
  onTogglePreviewAsPublic: () => void;
  onConfigure: () => void;
  // Manual curated re-cluster (Task #430) — editor-only on-demand trigger.
  onRecluster: () => void;
  isReclustering: boolean;
  onShowTour: () => void;
  tourButtonPulse?: boolean;
  onMcopBotOpen?: () => void;
}

function CuratedHeader({
  autoRefresh,
  onAutoRefreshChange,
  onManualRefresh,
  isRefreshing,
  search,
  onSearchChange,
  showSearchBar,
  showMcopBot,
  canModerate,
  previewAsPublic,
  onTogglePreviewAsPublic,
  onConfigure,
  onRecluster,
  isReclustering,
  onShowTour,
  tourButtonPulse,
  onMcopBotOpen,
}: CuratedHeaderProps) {
  const tz = useTimezone();
  const isMobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);

  // Header controls are defined ONCE here and rendered in EITHER the desktop
  // inline bar OR the mobile left pop-out menu (Task #378 mobile pass) — never
  // both at once (see the isMobile branch below), so every data-testid stays
  // unique in the DOM. Widths are fluid so each control adapts to the
  // horizontal bar or the vertical sheet stack.
  const searchControl = showSearchBar ? (
    <div className="relative w-full">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        placeholder="Search"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="pl-10 h-10 text-sm rounded-md bg-transparent shadow-md shadow-black/30 w-full"
        data-testid="input-header-search"
      />
    </div>
  ) : null;

  const mcopBotButton = showMcopBot ? (
    <button
      onClick={onMcopBotOpen}
      className="flex items-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      aria-label="Open MCOP Bot"
      data-testid="button-mcop-bot"
    >
      <img
        src={mcopBotIcon}
        alt="MCOP Bot"
        className="h-9 w-9 rounded-full object-cover shadow-md shadow-black/30"
        data-testid="img-mcop-bot"
      />
    </button>
  ) : null;

  const mcopBot = showMcopBot ? (
    isMobile ? (
      mcopBotButton
    ) : (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>{mcopBotButton}</TooltipTrigger>
          <TooltipContent side="bottom">Ask MCOP Bot</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  ) : null;

  const autoRefreshControl = (
    <div className="flex items-center gap-1.5">
      <Switch
        id="auto-refresh"
        checked={autoRefresh}
        onCheckedChange={onAutoRefreshChange}
        className="data-[state=checked]:bg-curated-accent shadow-md shadow-black/30"
        data-testid="switch-auto-refresh"
      />
      <label
        htmlFor="auto-refresh"
        className="text-sm font-medium cursor-pointer"
        data-testid="label-auto-refresh"
      >
        Auto-refresh
      </label>
    </div>
  );

  const refreshNowButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={onManualRefresh}
      disabled={isRefreshing}
      className="[border-color:hsl(var(--input))] shadow-md shadow-black/30"
      data-testid="button-refresh"
    >
      <RefreshCw
        className={`w-3.5 h-3.5 mr-1.5 ${isRefreshing ? "animate-spin" : ""}`}
      />
      {isRefreshing ? "Refreshing..." : "Refresh Now"}
    </Button>
  );

  // Manual curated re-cluster (Task #430) — editor-only. Kicks off a curated
  // clustering pass on demand so the Top Stories view regroups immediately after
  // hiding/relabeling stories or adding sources. Hidden for public + "view as
  // public" preview. CURATED-LANE ONLY.
  // `compact` renders the button icon-only (desktop bar — saves horizontal width
  // when the header is crunched); the mobile pop-out passes false to keep the
  // text label, since a lone icon in the vertical menu would be unclear.
  const renderReclusterButton = (compact: boolean) =>
    canModerate && !previewAsPublic ? (
      <Button
        variant="outline"
        size={compact ? "icon" : "sm"}
        onClick={onRecluster}
        disabled={isReclustering}
        className="border-curated-accent/60 text-curated-accent-strong shadow-md shadow-black/30"
        data-testid="button-recluster"
        title="Re-cluster: regroup Top Stories now (curated view only). May take 1–3 minutes."
        aria-label="Re-cluster Top Stories"
      >
        <Layers
          className={`w-4 h-4 ${compact ? "" : "mr-1.5"} ${isReclustering ? "animate-spin" : ""}`}
        />
        {!compact && (isReclustering ? "Re-clustering..." : "Re-cluster")}
      </Button>
    ) : null;

  const timezoneControl = (
    <div className="flex items-center gap-1.5">
      <span
        className="text-[11px] font-medium text-muted-foreground whitespace-nowrap"
        data-testid="label-timezone"
      >
        Showing as:
      </span>
      <Select value={tz} onValueChange={setSelectedTimezone}>
        <SelectTrigger
          className="h-8 w-[84px] text-xs gap-1 bg-transparent shadow-md shadow-black/30"
          data-testid="select-timezone"
        >
          <span data-testid="text-selected-timezone">{getTzAbbrev(tz)}</span>
        </SelectTrigger>
        <SelectContent>
          {TIMEZONE_OPTIONS.map((opt) => (
            <SelectItem
              key={opt.value}
              value={opt.value}
              data-testid={`option-timezone-${opt.value}`}
            >
              {opt.label} · {getTzAbbrev(opt.value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const viewSwitcher = (
    <ViewSwitcher
      current="curated"
      tone="curated"
      hasCuratedAccess
      className="flex-wrap"
    />
  );

  // "View as public" toggle (Task #380 expansion). Subtle blue italic text link;
  // shown ONLY to real allowlist editors. Flips an instant client-only state
  // that suppresses every editor affordance on the page (the PAGE access gate is
  // separate and stays real). No reload.
  const previewToggle = canModerate ? (
    <button
      type="button"
      onClick={onTogglePreviewAsPublic}
      className="italic text-xs text-curated-accent-strong hover:text-[#7FBDD4] whitespace-nowrap leading-none bg-transparent border-0 p-0 cursor-pointer [text-shadow:0_1px_2px_rgba(0,0,0,0.7)]"
      title={
        previewAsPublic
          ? "You are previewing the public view. Click to return to editor view."
          : "You are in editor view. Click to preview exactly what the public sees."
      }
      data-testid="button-preview-as-public"
    >
      {previewAsPublic ? "Viewing as public" : "Viewing as editor"}
    </button>
  ) : null;

  const configureButton = (
    <Button
      variant="outline"
      size="icon"
      onClick={onConfigure}
      aria-label="Configure Layout"
      className="[border-color:hsl(var(--input))] shadow-md shadow-black/30"
      data-testid="button-configure-layout"
    >
      <MonitorCog className="w-5 h-5" />
    </Button>
  );

  // Header entry point to (re)launch the Curated View walkthrough. This is the
  // element the opener + tour ending cards animate-absorb into, so its testid is
  // the shared absorb target. Pulses briefly (tourButtonPulse) right after the
  // opener is skipped, to show the viewer where the tour now lives.
  const tourButton = (
    <Button
      variant="outline"
      size="icon"
      onClick={onShowTour}
      aria-label="Take the tour"
      className={`[border-color:hsl(var(--input))] shadow-md shadow-black/30${
        tourButtonPulse ? " animate-pulse [border-color:#5FA8C4]" : ""
      }`}
      data-testid="button-curated-tour"
    >
      <Sparkles className="w-5 h-5" style={{ color: "#5FA8C4" }} />
    </Button>
  );

  // Storm-cloud header backdrop lives in CSS (.curated-header-storm) so the
  // wash can follow the app theme: DARK keeps the original near-black wash;
  // LIGHT lifts the clouds with a pale slate wash (the header itself stays
  // forced-`dark` so the white logo/controls render on both).
  // text-foreground on the header: the forced-`dark` class only redefines CSS
  // vars — text that INHERITS its color (e.g. outline-button labels) would keep
  // the page's computed light-mode (near-black) color and vanish on the storm
  // backdrop. Re-resolving color here yields the dark-scope near-white
  // foreground; in dark mode it's the value already inherited (no change).
  return (
    <header className="dark curated-header-storm text-foreground border-y border-border sticky top-0 z-50">
      <div className="max-w-[2200px] mx-auto px-3 py-1">
        {/* Terminal header: logo · (desktop) inline controls / (mobile) menu */}
        <div className="flex items-stretch gap-4">
          <div className="flex flex-col justify-center items-start shrink-0">
            <img
              src={mcopLogoWhite}
              alt="MCOP"
              className="h-14 md:h-24 w-auto [filter:drop-shadow(0_3px_4px_rgba(0,0,0,0.95))_drop-shadow(0_6px_12px_rgba(0,0,0,0.8))]"
              data-testid="icon-logo"
            />
            <p
              className="text-[10px] text-muted-foreground leading-tight"
              style={{ marginLeft: "5px" }}
              data-testid="text-app-subtitle"
            >
              Curated View
            </p>
          </div>

          {isMobile ? (
            /* MOBILE — controls collapse into a LEFT pop-out menu, EXCEPT the
               search bar, which stays inline in the bar so Top Stories can be
               searched without opening the menu (it renders HERE, not in the
               Sheet, keeping its data-testid unique in the DOM). */
            <div className="flex flex-1 min-w-0 items-center justify-end gap-2">
              {searchControl && (
                <div className="flex-1 min-w-0 max-w-[240px]">{searchControl}</div>
              )}
              <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
                <SheetTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Open menu"
                    className="[border-color:hsl(var(--input))] shadow-md shadow-black/30"
                    data-testid="button-open-menu"
                  >
                    <Menu className="w-5 h-5" />
                  </Button>
                </SheetTrigger>
                <SheetContent
                  side="left"
                  className="curated-surface bg-background text-foreground border-r-2 border-curated-accent/40 w-[86vw] max-w-sm overflow-y-auto"
                  data-testid="menu-mobile-header"
                >
                  <SheetHeader>
                    <SheetTitle>Menu</SheetTitle>
                  </SheetHeader>
                  <div className="mt-4 flex flex-col gap-4">
                    {mcopBot && (
                      <div className="flex items-center gap-2" onClick={() => setMenuOpen(false)}>
                        {mcopBot}
                        <span className="text-sm text-muted-foreground">
                          MCOP Bot
                        </span>
                      </div>
                    )}
                    {autoRefreshControl}
                    <div
                      className="flex flex-col gap-2"
                      onClick={() => setMenuOpen(false)}
                    >
                      {refreshNowButton}
                      {renderReclusterButton(false)}
                    </div>
                    {timezoneControl}
                    <div className="flex flex-col gap-2">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        Views
                      </span>
                      {viewSwitcher}
                    </div>
                    <div className="flex items-center justify-between gap-2 flex-wrap border-t border-border pt-3">
                      {previewToggle ?? <span />}
                      <div
                        className="flex items-center gap-2"
                        onClick={() => setMenuOpen(false)}
                      >
                        {tourButton}
                        {configureButton}
                      </div>
                    </div>
                  </div>
                </SheetContent>
              </Sheet>
            </div>
          ) : (
            /* DESKTOP — original single-row inline control bar. */
            <>
              <div className="flex-1 min-w-0 flex flex-col justify-center gap-1.5">
                <div className="flex items-center gap-4 flex-wrap">
                  {searchControl && (
                    <div className="w-64 shrink-0">{searchControl}</div>
                  )}
                  {/* wrap-reverse: when the header is width-constrained the
                      trailing items (Switch View, then timezone) rise to a NEW
                      line ABOVE the control cluster instead of colliding with it
                      — "raise them up to the top row." At full width everything
                      stays inline on one line. NOTE: no shrink-0 here — the group
                      must be allowed to compress below its single-line width or
                      the internal wrap never engages. */}
                  <div className="flex items-center justify-end gap-x-4 gap-y-1 flex-wrap-reverse">
                    <div className="flex items-center gap-3">
                      {mcopBot}
                      {autoRefreshControl}
                      {refreshNowButton}
                      {renderReclusterButton(true)}
                    </div>
                    {timezoneControl}
                    {viewSwitcher}
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-end justify-center gap-1.5 shrink-0">
                {previewToggle}
                <TooltipProvider delayDuration={150}>
                  <div className="flex items-center gap-2">
                    <Tooltip>
                      <TooltipTrigger asChild>{tourButton}</TooltipTrigger>
                      <TooltipContent side="bottom">
                        Take the tour
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>{configureButton}</TooltipTrigger>
                      <TooltipContent side="bottom">
                        Configure Layout
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </TooltipProvider>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

// -----------------------------------------------------------------------------
// Curated lane (Task #121) — a CONTRAST source row (CPC / low-factuality). Shown
// AS PART OF the story, flagged for contrast/spin, with an inline italic
// alignment statement summarizing how much of its claims ALIGN with the
// corroborated facts vs. which DIVERGE. The corroborated facts themselves are
// still built only from reliable news.
// -----------------------------------------------------------------------------
function cleanClause(s: string): string {
  return s.trim().replace(/[.;,\s]+$/, "");
}
// A phrase "flows after a pronoun subject" when it begins with a lowercase
// letter — i.e. it is a subjectless verb phrase like "confirms the strike".
function startsLower(s: string): boolean {
  const c = s.charAt(0);
  return c >= "a" && c <= "z";
}
function capFirst(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
// Give a claim its own subject only when it needs one. Subjectless verb
// phrases get an "it" subject; phrases that already carry their own subject
// (or start with a proper noun) are kept verbatim — so we never weld "It"
// onto a clause that already has a subject, and never lowercase a proper noun.
function clauseWithSubject(s: string): string {
  return startsLower(s) ? `it ${s}` : s;
}

// Group a pre-sorted (newest-first) member list by outlet name so the
// cluster detail pane can collapse multiple items from the same outlet
// into one primary row + an expandable overflow list.
function groupByOutlet(
  members: ClusterMember[],
): Array<{ source: string; items: ClusterMember[] }> {
  const groups: Array<{ source: string; items: ClusterMember[] }> = [];
  const indexBySource = new Map<string, number>();
  for (const m of members) {
    const key = m.source;
    if (indexBySource.has(key)) {
      groups[indexBySource.get(key)!].items.push(m);
    } else {
      indexBySource.set(key, groups.length);
      groups.push({ source: key, items: [m] });
    }
  }
  return groups;
}

function ContrastSourceRow({
  a,
  tz,
  groupSize = 1,
  editorControls,
}: {
  a: ClusterMember;
  tz: string;
  groupSize?: number;
  // CPC/contrast rows use a dedicated renderer, so their editor membership
  // controls are injected explicitly. Deliberately relocation-only: no
  // content-kind / classification control is offered for attach-only sources.
  editorControls?: React.ReactNode;
}) {
  // Newest row of a multi-item outlet group — stacked logos + count chip.
  const isGrouped = groupSize > 1;
  const breakdown = a.alignment;
  const alignPts = (breakdown?.align ?? []).map(cleanClause).filter(Boolean);
  const divergePts = (breakdown?.diverge ?? []).map(cleanClause).filter(Boolean);
  const totalPts = alignPts.length + divergePts.length;
  const hasBreakdown = totalPts > 0;
  // Prefer the AI's holistic 0-100 alignment estimate; fall back to a rough
  // proxy from the align/diverge point counts for rows synthesized before it.
  const alignPct =
    typeof breakdown?.pct === "number"
      ? Math.max(0, Math.min(100, Math.round(breakdown.pct)))
      : totalPts > 0
      ? Math.round((alignPts.length / totalPts) * 100)
      : 0;
  const alignClause = alignPts.join("; ");
  const divergeClause = divergePts.join("; ");
  let alignDetail = "";
  if (alignClause && divergeClause) {
    alignDetail =
      startsLower(alignClause) && startsLower(divergeClause)
        ? // Both are subjectless verb phrases — one shared "It" reads best.
          `It ${alignClause}, but ${divergeClause}.`
        : // Mixed / own-subject shapes — give each side its own subject so we
          // never produce a double-subject "It Israeli attacks may derail talks".
          `${capFirst(clauseWithSubject(alignClause))}, but ${clauseWithSubject(
            divergeClause,
          )}.`;
  } else if (alignClause) {
    alignDetail = `${capFirst(clauseWithSubject(alignClause))}.`;
  } else if (divergeClause) {
    alignDetail = `${capFirst(clauseWithSubject(divergeClause))}.`;
  }
  const alignmentStatement =
    `~${alignPct}% aligned with corroborated reporting.` +
    (alignDetail ? ` ${alignDetail}` : "");
  const kind = deriveContentType(a.url);
  return (
    <div
      className="flex items-start gap-2.5 rounded-md p-2"
      data-testid={`row-detail-contrast-${a.id}`}
    >
      <a href={a.url} target="_blank" rel="noreferrer" className="shrink-0">
        {isGrouped ? (
          <StackedSourceIcon
            source={a.source}
            url={a.url}
            tone="contrast"
            iconClassName="ring-1 ring-curated-contrast ring-offset-1 ring-offset-background"
          />
        ) : (
          <SourceIcon
            source={a.source}
            url={a.url}
            sizeClass="h-8 w-8"
            className="mt-0.5 ring-1 ring-curated-contrast ring-offset-1 ring-offset-background"
          />
        )}
      </a>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono text-curated-accent-strong shrink-0">{a.source}</span>
          <span className="text-xs font-mono text-curated-accent-strong shrink-0">
            · {formatDetailTime(a.publishedAt, tz)}
          </span>
          <ContentKindBadge kind={kind} />
          {editorControls}
        </div>
        {/* This outlet's OWN headline + click-out. */}
        <a
          href={a.url}
          target="_blank"
          rel="noreferrer"
          className="block text-sm leading-snug mt-0.5 hover:underline"
        >
          {a.displayTitle || a.title}
        </a>
        {/* This contrast outlet's own photo is intentionally NOT shown here —
            all cluster photos rotate on the hero carousel above. */}
        {/* Curated lane (Task #126) — 3-bullet AI summary when present, else the
            outlet's OWN standalone lede. Non-article items (video / opinion) are
            shown compact, WITHOUT a lede. */}
        {kind === "article" &&
          (a.summaryBullets && a.summaryBullets.length > 0 ? (
            <ul
              className="list-disc pl-5 mt-1 space-y-0.5 text-xs text-muted-foreground leading-snug"
              data-testid={`list-detail-bullets-${a.id}`}
            >
              {a.summaryBullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          ) : (
            a.summary && (
              <div
                className="text-xs text-muted-foreground leading-snug mt-1 line-clamp-3"
                data-testid={`text-detail-lede-${a.id}`}
              >
                {a.summary}
              </div>
            )
          ))}
        {/* Attributed one-sentence spin characterization. */}
        {a.spin && (
          <div
            className="text-xs italic text-muted-foreground leading-snug mt-1"
            data-testid={`text-detail-spin-${a.id}`}
          >
            {a.spin}
          </div>
        )}
        {hasBreakdown && (
          <div
            className="text-xs italic text-muted-foreground leading-snug mt-1"
            data-testid={`text-alignment-${a.id}`}
          >
            {alignmentStatement}
          </div>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Curated lane — image carousel for CLUSTERED stories. Instead of each
// contributing source repeating its own photo, ALL the cluster's distinct
// photos rotate on the one main image (the detail-dialog hero). It AUTO-rotates
// every 4s and renders no controls — deliberately NO inner <button> arrows/dots,
// because this carousel sits inside clickable parents. Nesting an interactive
// <button> inside another <button> is invalid HTML (validateDOMNesting warning)
// and can swallow clicks, so keep any nav controls as SIBLINGS of the clickable
// parent (see the Top Stories hero), never as children of this <img>.
// -----------------------------------------------------------------------------
function ImageCarousel({
  images,
  imgClassName,
  className,
  testId,
  compact = false,
  onHideImage,
}: {
  images: string[];
  imgClassName?: string;
  className?: string;
  testId?: string;
  compact?: boolean;
  // Allowlist-gated (Task #380 expansion) — when provided, a small "Hide photo"
  // overlay drops the CURRENTLY shown photo from this story's carousel/previews.
  // Editors only; the caller decides when to pass it (clusters in editor view).
  onHideImage?: (url: string) => void;
}) {
  const [idx, setIdx] = useState(0);
  // When the editor is using manual prev/next navigation, pause the auto-rotate
  // so the current photo stays in view long enough to hide it.
  const [manuallyPaused, setManuallyPaused] = useState(false);
  // Reset to the first photo whenever the image set changes (e.g. a different
  // story opens in the same dialog, or the card list reorders).
  const sig = images.join("|");
  useEffect(() => {
    setIdx(0);
    setManuallyPaused(false);
  }, [sig]);
  // Auto-rotate through the cluster's photos on its own. Cycles every 4s and
  // pauses when there's only one image or the editor took manual control.
  const count = images.length;
  useEffect(() => {
    if (count <= 1 || manuallyPaused) return;
    const t = setInterval(() => setIdx((i) => i + 1), 4000);
    return () => clearInterval(t);
  }, [sig, count, manuallyPaused]);
  if (images.length === 0) return null;
  const safe = ((idx % images.length) + images.length) % images.length;
  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    setManuallyPaused(true);
    setIdx((i) => i - 1);
  };
  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    setManuallyPaused(true);
    setIdx((i) => i + 1);
  };
  return (
    <div className={`relative overflow-hidden ${className ?? ""}`}>
      <img
        src={images[safe]}
        alt=""
        loading="lazy"
        className={`absolute inset-0 w-full h-full object-cover ${imgClassName ?? ""}`}
        data-testid={testId}
      />
      {/* Editor-only manual navigation: prev/next arrows + position dots so the
          editor can land on any specific photo to hide it. Non-editors see only
          the auto-rotate (no controls). Only shown when there are multiple photos. */}
      {onHideImage && count > 1 && (
        <>
          <button
            type="button"
            onClick={handlePrev}
            className="absolute left-2 top-1/2 -translate-y-1/2 z-20 inline-flex items-center justify-center h-7 w-7 rounded-full bg-black/60 backdrop-blur-sm text-white border border-white/20"
            title="Previous photo"
            data-testid="button-carousel-prev"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={handleNext}
            className="absolute right-2 top-1/2 -translate-y-1/2 z-20 inline-flex items-center justify-center h-7 w-7 rounded-full bg-black/60 backdrop-blur-sm text-white border border-white/20"
            title="Next photo"
            data-testid="button-carousel-next"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1">
            {images.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all ${i === safe ? "w-3 bg-white" : "w-1.5 bg-white/40"}`}
              />
            ))}
          </div>
        </>
      )}
      {onHideImage && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onHideImage(images[safe]);
          }}
          className="absolute bottom-2 left-2 z-20 inline-flex items-center gap-1 rounded-md bg-black/55 backdrop-blur-sm px-2 py-1 text-[11px] font-medium text-white border border-white/20"
          title="Hide this photo"
          data-testid="button-hide-photo"
        >
          <EyeOff className="h-3.5 w-3.5" />
          Hide photo
        </button>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Top Story detail pop-out
// -----------------------------------------------------------------------------
// Editor-gated Priority (P) badge. Shown ONLY to Curated EDITORS — callers gate
// on `canEdit`, which stays allowlist-only even after the view reveal, so the
// badge never renders for view-only users. Click opens an editor to pin a 1–100 P score;
// hover shows the live top-5 / top-30 ranking-score cutoffs plus this story's own
// ranking score. The override is CURATED-ONLY — the mutation hits the dedicated
// curated endpoint and never touches the main-feed priority columns.
// Tiny, VIEW-ONLY priority tag for the editor's card previews (Task #380
// expansion). Shows the same P-score as the interactive detail badge but is
// NOT clickable — the pin control lives only in the story detail pop-out. The
// caller gates this on editor mode (`effectiveAccess`); it is never public.
function CuratedPriorityTag({
  story,
  onLight = false,
  overlay = false,
  testId,
  hasAccess,
  rankingCutoffs,
}: {
  story: CuratedStory;
  // onLight = rendered over a dark hero image (white text); otherwise the
  // accent cyan used elsewhere in the curated metadata rows.
  onLight?: boolean;
  // overlay = render as a tiny absolute label anchored snug just above the
  // card thumbnail (takes no layout flow). Used on the ranked rows for BOTH
  // single-source and cluster stories so cluster P-scores are visible too.
  overlay?: boolean;
  testId?: string;
  // When provided, wraps the tag in a read-only hover tooltip showing the same
  // ranking metadata as the detail-view priority badge (editor-only parity).
  hasAccess?: boolean;
  rankingCutoffs?: { top5: number | null; top30: number | null };
}) {
  const pinned = story.priorityOverride != null;
  // Display the DECAYED score (priorityScore already reflects the pin cooled by
  // age on the server) — pins are no longer exempt from time-decay. `pinned`
  // only drives the bold styling + tooltip note.
  const displayScore = Math.round(story.priorityScore ?? 0);
  const fmtScore = (n: number | null | undefined) =>
    n == null ? "—" : Number.isInteger(n) ? String(n) : n.toFixed(1);
  const tag = (
    <span
      className={`font-mono shrink-0 rounded-sm ${
        overlay
          ? "absolute bottom-full left-1/2 -translate-x-1/2 mb-0 z-10 text-[9px] leading-none px-0.5 backdrop-blur-sm"
          : "leading-none px-1 text-[10px]"
      } ${
        onLight ? "text-white bg-white/20" : "text-curated-accent-strong bg-curated-accent/10"
      } ${pinned ? "font-semibold" : ""}`}
      data-testid={testId ?? `tag-priority-${story.id}`}
    >
      P{displayScore}
    </span>
  );
  if (!hasAccess || !rankingCutoffs) return tag;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{tag}</TooltipTrigger>
        <TooltipContent side="left" className="font-mono text-xs space-y-0.5">
          <div data-testid={`text-ranking-score-tag-${story.id}`}>
            Ranking score: {fmtScore(story.rankingScore)}
          </div>
          <div>Top 5 cutoff: {fmtScore(rankingCutoffs.top5)}</div>
          <div>Top 30 cutoff: {fmtScore(rankingCutoffs.top30)}</div>
          {pinned && <div>Pinned at P{story.priorityOverride} (decays with age)</div>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Amber warning icon for dead/unavailable links, using a styled tooltip
 * instead of a native `title` attribute so the label is touch-accessible and
 * matches the rest of the curated tooltip pattern.
 *
 * Uses the same controlled open-state + click-toggle pattern as SectionHeading
 * so tap-open works on touch devices. (MethodologyInfoIcon is now a Popover —
 * its trigger sits inside the story Dialog, whose auto-focus would pop a
 * focus-opened Tooltip; this cue is not in that position, so Tooltip is fine.)
 */
function DeadLinkCue({ testId }: { testId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <span
            role="button"
            tabIndex={0}
            className="shrink-0 inline-flex items-center gap-1 text-amber-500 cursor-default"
            data-testid={testId}
            onClick={() => setOpen((o) => !o)}
            onKeyDown={(e) => e.key === "Enter" && setOpen((o) => !o)}
          >
            <AlertTriangle className="h-3 w-3" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="text-xs pointer-events-auto">
          Link unavailable
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Dismissible inline reason prompt shown after a P-score pin is applied.
// The score is already written — this call is best-effort.
const PRIORITY_REASON_EXPLAINERS: Record<string, string> = {
  "us-allied-consequence": "Direct effect on U.S. forces, allies, security, policy, or interests.",
  "leadership-watch-interest": "Matches leadership priorities, standing watch items, or decision needs.",
  "operational-readiness-impact": "Changes force posture, capabilities, access, logistics, or readiness.",
  "imminence-freshness": "Time-sensitive, newly developing, or likely to matter soon.",
  novelty: "A genuinely new development rather than routine repetition or recap.",
  "comparative-ranking": "Adjusts this score relative to other stories competing for attention.",
  "aftermath-downstream": "Covers response, recovery, or secondary effects after the main event.",
  "decay-error": "The score fell too far with age even though the story remains important.",
  other: "Use when none of the listed reasons fit; add context in the quick note.",
};

function PriorityReasonPrompt({
  eventId,
  storyId,
  onDismiss,
}: {
  eventId: string;
  storyId: string;
  onDismiss: () => void;
}) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string>("");
  const [expanded, setExpanded] = useState(false);

  const submit = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/curated/override-event/${eventId}/reasons`, {
        reasonKeys: Array.from(selected),
        reasonNote: note.trim() || null,
      });
      return res.json();
    },
    onSuccess: () => {
      onDismiss();
    },
    onError: () => {
      // Best-effort — never block on this; just dismiss.
      toast({ title: "Could not save reason", description: "The priority was already updated.", variant: "destructive" });
      onDismiss();
    },
  });

  if (!expanded) {
    return (
      <div
        className="flex items-center gap-1.5 mt-1.5 rounded-md border border-curated-accent/40 bg-curated-accent/5 px-2 py-1.5"
        data-testid={`section-priority-reason-prompt-${storyId}`}
      >
        <span className="text-xs text-curated-accent-strong flex-1">Add reason? (optional)</span>
        <button
          type="button"
          className="text-xs text-curated-accent-strong underline shrink-0"
          onClick={() => setExpanded(true)}
          data-testid={`button-expand-priority-reason-${storyId}`}
        >
          Add
        </button>
        <button
          type="button"
          className="text-xs text-muted-foreground shrink-0"
          onClick={onDismiss}
          data-testid={`button-dismiss-priority-reason-${storyId}`}
        >
          Skip
        </button>
      </div>
    );
  }

  return (
    <div
      className="mt-1.5 rounded-md border border-curated-accent/40 bg-curated-accent/5 p-2 space-y-2"
      data-testid={`section-priority-reason-expanded-${storyId}`}
    >
      <p className="text-xs text-curated-accent-strong">Why this score? (optional)</p>
      <div className="flex flex-wrap gap-1.5">
        {SCORE_ADJUST_REASONS.map((r) => {
          const active = selected.has(r.key);
          const explainer = PRIORITY_REASON_EXPLAINERS[r.key];
          return (
            <Tooltip key={r.key}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(r.key)) next.delete(r.key);
                      else next.add(r.key);
                      return next;
                    })
                  }
                  className={`text-xs px-1.5 py-0.5 rounded-md border transition-colors ${
                    active
                      ? "bg-curated-accent/20 border-curated-accent text-curated-accent-strong"
                      : "border-border text-muted-foreground hover:border-curated-accent/50"
                  }`}
                  aria-describedby={explainer ? `priority-reason-help-${r.key}` : undefined}
                  data-testid={`chip-priority-reason-${r.key}`}
                >
                  {r.label}
                </button>
              </TooltipTrigger>
              {explainer && (
                <TooltipContent
                  side="left"
                  className="max-w-56 text-xs leading-relaxed"
                  id={`priority-reason-help-${r.key}`}
                >
                  {explainer}
                </TooltipContent>
              )}
            </Tooltip>
          );
        })}
      </div>
      <Textarea
        placeholder="Quick note (optional)…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="text-xs resize-none h-12"
        maxLength={500}
        data-testid={`input-priority-reason-note-${storyId}`}
      />
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={onDismiss}
          data-testid={`button-skip-priority-reason-${storyId}`}
        >
          Skip
        </Button>
        <Button
          size="sm"
          variant="curated"
          onClick={() => submit.mutate()}
          disabled={submit.isPending}
          data-testid={`button-save-priority-reason-${storyId}`}
        >
          {submit.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
        </Button>
      </div>
    </div>
  );
}

function CuratedPriorityBadge({
  story,
  rankingCutoffs,
  overlay = false,
}: {
  story: CuratedStory;
  rankingCutoffs: { top5: number | null; top30: number | null };
  // overlay = render as a tiny absolute label anchored to the outlet logo
  // (takes no layout flow) instead of an inline metadata-line token.
  overlay?: boolean;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<string>("");
  // Post-apply reason prompt: holds the event id returned by the server so
  // the editor can optionally annotate why they changed the score.
  const [pendingReasonEventId, setPendingReasonEventId] = useState<string | null>(null);

  const isCluster = story.sourceCount > 1;
  const pinned = story.priorityOverride != null;
  // Display the DECAYED score (server already cooled any pin by age) — pins are
  // no longer decay-exempt. `pinned` only drives styling + the tooltip note.
  const displayScore = Math.round(story.priorityScore ?? 0);

  const mutation = useMutation({
    mutationFn: async (priorityScore: number) => {
      const body = isCluster
        ? { scope: "cluster", clusterId: story.clusterId, priorityScore }
        : { scope: "standalone", type: story.type, id: story.id, priorityScore };
      const res = await apiRequest("POST", "/api/curated/priority-override", body);
      return res.json();
    },
    onSuccess: (data, priorityScore) => {
      queryClient.invalidateQueries({ queryKey: ["/api/curated/top-stories"] });
      toast({ title: "Priority pinned", description: `Set to P${priorityScore} (Curated view only).` });
      // Keep the popover open so the reason prompt is visible. The prompt's
      // dismiss/save handlers will call setOpen(false) + clear the event id.
      if (data?.eventId) {
        setPendingReasonEventId(data.eventId);
      } else {
        setOpen(false);
      }
    },
    onError: () => {
      toast({ title: "Failed to update priority", variant: "destructive" });
    },
  });

  const handleSave = () => {
    const n = parseInt(value, 10);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      toast({ title: "Enter a whole number 1–100", variant: "destructive" });
      return;
    }
    mutation.mutate(n);
  };

  const fmt = (n: number | null | undefined) =>
    n == null ? "—" : Math.round(n).toString();

  return (
    <TooltipProvider>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) setValue(String(displayScore));
          // Closing by outside click must also discard any pending post-apply
          // reason prompt, or reopening later shows a stale prompt.
          if (!o) setPendingReasonEventId(null);
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <span
                role="button"
                tabIndex={0}
                className={`font-mono cursor-pointer shrink-0 rounded-sm text-curated-accent-strong ${
                  overlay
                    ? "absolute bottom-full left-1/2 -translate-x-1/2 mb-0.5 z-10 text-[9px] leading-none px-0.5 backdrop-blur-sm"
                    : "text-xs leading-none px-1"
                } ${
                  pinned ? "bg-curated-accent/25 font-semibold" : "bg-curated-accent/10"
                }`}
                onClick={(e) => e.stopPropagation()}
                data-testid={`badge-priority-${story.id}`}
              >
                P{displayScore}
              </span>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="left" className="font-mono text-xs space-y-0.5">
            <div data-testid={`text-ranking-score-${story.id}`}>
              Ranking score: {fmt(story.rankingScore)}
            </div>
            <div>Top 5 cutoff: {fmt(rankingCutoffs.top5)}</div>
            <div>Top 30 cutoff: {fmt(rankingCutoffs.top30)}</div>
            {pinned && <div>Pinned at P{story.priorityOverride} (decays with age)</div>}
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          className="w-52 p-3"
          align="end"
          onClick={(e) => e.stopPropagation()}
          data-testid={`popover-priority-${story.id}`}
        >
          <div className="space-y-2">
            <p className="text-xs font-semibold">Pin Priority (1–100)</p>
            <p className="text-xs text-muted-foreground">
              Affects the Curated view only.
            </p>
            <Input
              type="number"
              min={1}
              max={100}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
              }}
              data-testid={`input-priority-${story.id}`}
            />
            <Button
              size="sm"
              variant="curated"
              className="w-full"
              onClick={handleSave}
              disabled={mutation.isPending}
              data-testid={`button-save-priority-${story.id}`}
            >
              {mutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Save"
              )}
            </Button>
            {/* Post-apply reason prompt lives inside the popover so it stays
                near the badge without affecting surrounding layout flow.
                Both dismiss paths (skip + save) close the popover. */}
            {pendingReasonEventId && (
              <PriorityReasonPrompt
                eventId={pendingReasonEventId}
                storyId={story.id}
                onDismiss={() => {
                  setPendingReasonEventId(null);
                  setOpen(false);
                }}
              />
            )}
          </div>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}

// Editor-gated "Replace link" control. Rendered ONLY for curated rows/members
// whose URL a liveness probe confirmed dead, and ONLY to Curated EDITORS
// (callers gate on `canEdit`, which stays allowlist-only). Opens a small editor to
// paste a working replacement URL; the mutation hits the dedicated curated
// endpoint (server-side SSRF-validated), which stores a curated-only overlay,
// clears the dead flag, and resets enrichment so photo/bullets re-fetch from the
// new URL. Never touches the main feed. `onReplaced` lets the caller refresh.
function ReplaceLinkControl({
  itemId,
  onReplaced,
}: {
  itemId: string;
  onReplaced?: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<string>("");

  const mutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await apiRequest("POST", "/api/curated/replace-link", {
        type: "curated",
        id: itemId,
        url,
      });
      return res.json();
    },
    onMutate: async (newUrl: string) => {
      // Optimistic update — clear the dead-link flag and update the URL
      // immediately so the editor sees the effect without a round-trip delay.
      await queryClient.cancelQueries({ queryKey: ["/api/curated/top-stories"] });
      const prev = queryClient.getQueryData(["/api/curated/top-stories", { hours: 24, limit: 100 }]);
      queryClient.setQueriesData<{ stories?: CuratedStory[] } & Record<string, unknown>>(
        { queryKey: ["/api/curated/top-stories"] },
        (old) => {
          if (!old?.stories) return old;
          return {
            ...old,
            stories: old.stories.map((s: CuratedStory) =>
              s.id === itemId ? { ...s, url: newUrl, linkDead: false } : s,
            ),
          };
        },
      );
      return { prev };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/curated/top-stories"] });
      queryClient.invalidateQueries({ queryKey: ["/api/curated/cluster-members"] });
      toast({ title: "Link replaced", description: "The article link has been updated." });
      setOpen(false);
      setValue("");
      onReplaced?.();
    },
    onError: (_err, _vars, context) => {
      if (context?.prev !== undefined) {
        queryClient.setQueryData(["/api/curated/top-stories", { hours: 24, limit: 100 }], context.prev);
      }
      toast({ title: "Failed to replace link", description: "Check the URL and try again.", variant: "destructive" });
    },
  });

  const handleSave = () => {
    const url = value.trim();
    if (!/^https?:\/\//i.test(url)) {
      toast({ title: "Enter a full URL (https://…)", variant: "destructive" });
      return;
    }
    mutation.mutate(url);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          onClick={(e) => e.stopPropagation()}
          data-testid={`button-replace-link-${itemId}`}
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Replace link
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-3"
        align="start"
        onClick={(e) => e.stopPropagation()}
        data-testid={`popover-replace-link-${itemId}`}
      >
        <div className="space-y-2">
          <p className="text-xs font-semibold">Replace dead article link</p>
          <p className="text-xs text-muted-foreground">
            Paste a working URL for this story. Curated view only.
          </p>
          <Input
            type="url"
            placeholder="https://example.com/article"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
            }}
            data-testid={`input-replace-link-${itemId}`}
          />
          <Button
            size="sm"
            variant="curated"
            className="w-full"
            onClick={handleSave}
            disabled={mutation.isPending}
            data-testid={`button-save-replace-link-${itemId}`}
          >
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Replace"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Editor-gated "Remove from story" control (Task #955). Rendered ONLY inside a
// clustered story's member list and ONLY to Curated EDITORS (callers gate on
// `hasAccess`/`canEdit`, which stays allowlist-only). Pulls ONE wrongly-merged
// member out of the story via the curated-only eviction overlay: it posts the
// member's URL plus an anchor snapshot of its siblings (so the overlay targets
// THIS cluster and no other) and re-shapes immediately. Fully reversible from
// the Source Oversight editor trail. Never touches the main feed.
function EvictMemberControl({
  evictedUrl,
  anchorUrls,
  storyLabel,
  memberId,
}: {
  evictedUrl: string;
  anchorUrls: string[];
  storyLabel: string;
  memberId: string;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/curated/evict-item", {
        evictedUrl,
        anchorUrls,
        label: storyLabel,
      });
      return res.json() as Promise<{ ok: boolean; reshaped?: boolean; deferred?: boolean }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/curated/top-stories"] });
      queryClient.invalidateQueries({ queryKey: ["/api/curated/cluster-members"] });
      queryClient.invalidateQueries({ queryKey: ["/api/curated/evictions"] });
      toast({
        title: "Removed from story",
        description:
          "This item was pulled out and will stand on its own. Reversible from the editor trail in Source Oversight.",
      });
      setOpen(false);
    },
    onError: () => {
      toast({ title: "Couldn't remove the item", description: "Please try again.", variant: "destructive" });
    },
  });

  // Need at least two siblings to positively identify the wrongly-merged cluster.
  if (anchorUrls.length < 2) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 text-[#5FA8C4]"
                onClick={(e) => {
                  // The row is a link: block navigation, then toggle the
                  // confirm popover OURSELVES — Radix skips its own toggle
                  // when the click's default is prevented.
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen((o) => !o);
                }}
                data-testid={`button-evict-member-${memberId}`}
              >
                <Unlink className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Remove from story</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        className="w-72 p-3"
        align="start"
        onClick={(e) => e.stopPropagation()}
        data-testid={`popover-evict-member-${memberId}`}
      >
        <div className="space-y-2">
          <p className="text-xs font-semibold">Remove this item from the story?</p>
          <p className="text-xs text-muted-foreground">
            It doesn't belong to this story. It will be pulled out and stand on
            its own. This is reversible from the editor trail. Curated view only.
          </p>
          <Button
            size="sm"
            variant="destructive"
            className="w-full"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            data-testid={`button-confirm-evict-member-${memberId}`}
          >
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Remove from story"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Editor-only MOVE MEMBER control — "this belongs in that OTHER story."
// One atomic decision: pull the item out of the story it was wrongly merged
// into AND re-home it in a destination story the editor picks. Writes the
// dedicated curated_manual_moves overlay (NOT an evict + link composite — a
// link naming both sides would fuse the two clusters). If the destination
// story later disperses, the move degrades to a plain removal (the item
// stands alone, never lost). Curated view only, reversible from the trail.
function MoveMemberControl({
  itemUrl,
  sourceAnchorUrls,
  currentStoryKey,
  memberId,
}: {
  itemUrl: string;
  sourceAnchorUrls: string[];
  currentStoryKey: string;
  memberId: string;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [search, setSearch] = useState<string>("");

  // Read the SAME cached Top Stories list the page already fetched; offer
  // every OTHER formed story (>= 2 members besides this item) as a target.
  const { data: topStoriesData } = useQuery<{ stories?: CuratedStory[] }>({
    queryKey: ["/api/curated/top-stories", { hours: 24, limit: 100 }],
  });
  const candidates = useMemo(() => {
    return (topStoriesData?.stories ?? []).filter((s) => {
      if (storyKey(s) === currentStoryKey) return false;
      const urls = storyIdentityUrls(s).filter((u) => u !== itemUrl);
      return urls.length >= 2; // server requires >= 2 target anchors
    });
  }, [topStoriesData, currentStoryKey, itemUrl]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((s) => buildStorySearchText(s).includes(q));
  }, [candidates, search]);

  const selectedStory = candidates.find((s) => storyKey(s) === selectedKey) ?? null;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!selectedStory) throw new Error("no target selected");
      const res = await apiRequest("POST", "/api/curated/move-member", {
        itemUrl,
        sourceAnchorUrls,
        targetAnchorUrls: storyIdentityUrls(selectedStory).filter((u) => u !== itemUrl),
        label: selectedStory.headline || selectedStory.displayTitle || selectedStory.title || "",
      });
      return res.json() as Promise<{ ok: boolean; reshaped?: boolean; deferred?: boolean }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/curated/moves"] });
      queryClient.invalidateQueries({ queryKey: ["/api/curated/top-stories"] });
      queryClient.invalidateQueries({ queryKey: ["/api/curated/cluster-members"] });
      toast({
        title: data?.deferred ? "Move saved — regrouping in progress" : "Moved to the other story",
        description: data?.deferred
          ? "Recorded to the editor trail. It applies the moment the current clustering pass finishes."
          : "The item now rides its new story. Reversible from the editor trail in Source Oversight.",
      });
      setOpen(false);
      setSelectedKey(null);
      setSearch("");
    },
    onError: () => {
      toast({ title: "Couldn't move the item", description: "Please try again.", variant: "destructive" });
    },
  });

  if (candidates.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setSelectedKey(null); setSearch(""); } }}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 text-[#5FA8C4]"
                onClick={(e) => {
                  // The row is a link: block navigation, then open the dialog
                  // OURSELVES — Radix skips its own toggle when the click's
                  // default is prevented.
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(true);
                }}
                data-testid={`button-move-member-${memberId}`}
              >
                <ArrowRightLeft className="h-3.5 w-3.5" />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Move to another story</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DialogContent
        className="dark bg-background text-foreground border-2 border-[#5FA8C4]/50 max-w-xl w-[95vw] max-h-[85vh] overflow-y-auto"
        style={{ "--background": "0 0% 15%", "--border": "0 0% 50%" } as React.CSSProperties}
        data-testid={`dialog-move-member-${memberId}`}
        onClick={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>Move to another story</DialogTitle>
          <DialogDescription>
            Pick the story this item actually belongs to. It leaves its current
            story and joins the one you choose — one reversible action, logged
            for the Source Oversight review. Curated view only.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search stories by keyword…"
            className="pl-8"
            data-testid="input-search-move-targets"
          />
        </div>

        <div className="max-h-64 overflow-y-auto divide-y divide-border rounded-md border border-border" data-testid="list-move-targets">
          {visible.length === 0 && (
            <div className="p-3 text-sm text-muted-foreground" data-testid="text-no-move-matches">
              {search.trim() ? `No stories match “${search.trim()}”.` : "No other stories available."}
            </div>
          )}
          {visible.map((s) => {
            const k = storyKey(s);
            const active = selectedKey === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setSelectedKey(active ? null : k)}
                className="w-full text-left flex items-start gap-2 p-2 hover-elevate"
                data-testid={`option-move-target-${s.id}`}
              >
                <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-border flex items-center justify-center">
                  {active && <Check className="h-3 w-3 text-[#5FA8C4]" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm leading-snug truncate">
                    {s.headline || s.displayTitle || s.title}
                  </span>
                  <span className="block text-xs text-muted-foreground font-mono">
                    {s.sourceCount > 1 ? `${s.sourceCount} sources` : s.source}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <Button
          variant="curated"
          className="w-full"
          onClick={() => mutation.mutate()}
          disabled={!selectedStory || mutation.isPending}
          data-testid={`button-confirm-move-member-${memberId}`}
        >
          {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Move it there"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

// Build the SERVER-side hide scope payload for a story (clusters vs standalone),
// plus the current member keys so a later re-cluster of the same story stays
// hidden. Mirrors the key the curated read path / priority-override endpoint use.
function buildHideBody(story: CuratedStory, hidden: boolean) {
  const isCluster = story.sourceCount > 1 && !!story.clusterId;
  const memberKeys = (story.members ?? [])
    .map((m) => (m.itemType ? `${m.itemType}:${m.id}` : null))
    .filter((k): k is string => !!k);
  return isCluster
    ? { scope: "cluster", clusterId: story.clusterId, memberKeys, hidden }
    : { scope: "standalone", type: story.type, id: story.id, memberKeys, hidden };
}

// Allowlist-gated per-item CONTENT-KIND OVERRIDE (Task #892). Rendered ONLY to
// curated editors. Lets an editor permanently mark a story as Analysis /
// Opinion / Editorial / Other so the clustering gate and every headline surface
// treat it as non-reported-article immediately (fail-closed, curated-only).
function CuratedContentKindOverrideControl({ story }: { story: CuratedStory }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const KINDS = [
    { value: "analysis", label: "Analysis" },
    { value: "opinion", label: "Opinion" },
    { value: "editorial", label: "Editorial" },
    { value: "explainer", label: "Explainer" },
    { value: "other", label: "Other / Commentary" },
  ] as const;

  const { data: existing, refetch } = useQuery<{ kind: string | null }>({
    queryKey: ["/api/curated/content-kind-override", story.url],
    queryFn: async () => {
      const res = await fetch(
        `/api/curated/content-kind-override?url=${encodeURIComponent(story.url)}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to load content-kind override");
      return res.json();
    },
    enabled: open,
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: async (kind: string | null) => {
      const res = await apiRequest("POST", "/api/curated/content-kind-override", {
        url: story.url,
        kind,
      });
      return res.json();
    },
    onSuccess: (_, kind) => {
      queryClient.invalidateQueries({ queryKey: ["/api/curated/top-stories"] });
      refetch();
      toast({
        title: kind ? `Marked as ${kind}` : "Content-kind mark cleared",
        description: "Curated clustering and headline surfaces updated.",
      });
    },
    onError: () => toast({ title: "Failed to update content-kind mark", variant: "destructive" }),
  });

  const current = existing?.kind ?? null;
  const currentLabel = KINDS.find((k) => k.value === current)?.label;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className={`text-curated-accent-strong ${current ? "bg-curated-accent/20" : ""}`}
                data-testid="button-content-kind-override"
              >
                <Tags className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{current ? `Kind: ${currentLabel}` : "Mark kind"}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent className="dark bg-background border border-border p-2 w-48 space-y-1" side="bottom" align="start">
        <div className="text-xs text-muted-foreground px-1 pb-1 font-medium">Content kind override</div>
        {KINDS.map((k) => (
          <button
            key={k.value}
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(k.value)}
            className={`w-full text-left rounded px-2 py-1.5 text-sm transition-colors hover-elevate ${current === k.value ? "bg-curated-accent/20 text-curated-accent-strong" : "text-foreground"}`}
            data-testid={`button-content-kind-${k.value}`}
          >
            {k.label}
          </button>
        ))}
        {current && (
          <>
            <div className="border-t border-border my-1" />
            <button
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(null)}
              className="w-full text-left rounded px-2 py-1.5 text-sm text-muted-foreground hover-elevate"
              data-testid="button-content-kind-clear"
            >
              Clear mark
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EDITOR member-level controls (Task #957) — appear in the cluster detail
// popup per-member row, gated to allowlisted editors (hasAccess). Both are
// compact icon buttons placed inline with the source line.
// ─────────────────────────────────────────────────────────────────────────────

// Per-member "mark kind" control — reuses the existing content-kind-override
// endpoint (already keyed by URL). Behaves identically to
// CuratedContentKindOverrideControl but takes a raw URL instead of a
// CuratedStory (used for cluster members that may not be the story rep).
function MemberKindControl({ memberUrl }: { memberUrl: string }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const KINDS = [
    { value: "analysis", label: "Analysis" },
    { value: "opinion", label: "Opinion" },
    { value: "editorial", label: "Editorial" },
    { value: "explainer", label: "Explainer" },
    { value: "other", label: "Other / Commentary" },
  ] as const;

  const { data: existing, refetch } = useQuery<{ kind: string | null }>({
    queryKey: ["/api/curated/content-kind-override", memberUrl],
    queryFn: async () => {
      const res = await fetch(
        `/api/curated/content-kind-override?url=${encodeURIComponent(memberUrl)}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to load content-kind override");
      return res.json();
    },
    enabled: open,
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: async (kind: string | null) => {
      const res = await apiRequest("POST", "/api/curated/content-kind-override", {
        url: memberUrl,
        kind,
      });
      return res.json();
    },
    onSuccess: (_, kind) => {
      queryClient.invalidateQueries({ queryKey: ["/api/curated/top-stories"] });
      refetch();
      toast({
        title: kind ? `Marked as ${kind}` : "Content-kind mark cleared",
        description: "Curated clustering and headline surfaces updated.",
      });
    },
    onError: () =>
      toast({ title: "Failed to update content-kind mark", variant: "destructive" }),
  });

  const current = existing?.kind ?? null;
  const currentLabel = KINDS.find((k) => k.value === current)?.label;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className={`h-6 w-6 text-[#5FA8C4] ${current ? "bg-[#5FA8C4]/20" : ""}`}
                onClick={(e) => {
                  // The row is a link: block navigation, then toggle the
                  // popover OURSELVES — Radix skips its own toggle when the
                  // click's default is prevented.
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen((o) => !o);
                }}
                data-testid="button-member-kind"
              >
                <Tags className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {current ? `Kind: ${currentLabel}` : "Mark kind"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        className="dark bg-background border border-border p-2 w-48 space-y-1"
        side="bottom"
        align="start"
      >
        <div className="text-xs text-muted-foreground px-1 pb-1 font-medium">
          Content kind override
        </div>
        {KINDS.map((k) => (
          <button
            key={k.value}
            disabled={mutation.isPending}
            onClick={(e) => {
              e.stopPropagation();
              mutation.mutate(k.value);
            }}
            className={`w-full text-left rounded px-2 py-1.5 text-sm transition-colors hover-elevate ${
              current === k.value ? "bg-[#5FA8C4]/20 text-[#5FA8C4]" : "text-foreground"
            }`}
            data-testid={`button-member-kind-${k.value}`}
          >
            {k.label}
          </button>
        ))}
        {current && (
          <>
            <div className="border-t border-border my-1" />
            <button
              disabled={mutation.isPending}
              onClick={(e) => {
                e.stopPropagation();
                mutation.mutate(null);
              }}
              className="w-full text-left rounded px-2 py-1.5 text-sm text-muted-foreground hover-elevate"
              data-testid="button-member-kind-clear"
            >
              Clear mark
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

// Allowlist-gated HIDE / UN-HIDE control (Task #380). Rendered ONLY to curated
// editors (callers gate on hasAccess). One click takes a bad story OFF every
// curated read surface (card, detail, Top Narratives); the same control un-hides
// it. The mutation hits the dedicated curated endpoint — never the main feed.
// `hidden` reflects current state (true on the Hidden-stories review panel).
function CuratedHideControl({
  story,
  hidden = false,
  variant = "button",
  onChanged,
}: {
  story: CuratedStory;
  hidden?: boolean;
  // "button" = full labeled button (detail pop-out / hidden panel);
  // "icon" = compact icon button (card overlay).
  variant?: "button" | "icon";
  onChanged?: () => void;
}) {
  const { toast } = useToast();
  const mutation = useMutation({
    mutationFn: async (nextHidden: boolean) => {
      const res = await apiRequest(
        "POST",
        "/api/curated/hide-story",
        buildHideBody(story, nextHidden),
      );
      return res.json();
    },
    onMutate: async (nextHidden) => {
      // Optimistic update for HIDE: immediately remove the story card so the
      // editor sees the effect without waiting for the server round-trip.
      // Restore is less critical (doesn't remove anything visible) so we just
      // let the invalidation refetch handle it normally. Rolled back on error.
      if (!nextHidden) return undefined;
      await queryClient.cancelQueries({ queryKey: ["/api/curated/top-stories"] });
      const prev = queryClient.getQueryData(["/api/curated/top-stories", { hours: 24, limit: 100 }]);
      queryClient.setQueriesData<{ stories?: CuratedStory[] } & Record<string, unknown>>(
        { queryKey: ["/api/curated/top-stories"] },
        (old) => {
          if (!old?.stories) return old;
          return {
            ...old,
            stories: old.stories.filter((s: CuratedStory) => {
              if (story.clusterId && s.clusterId) return s.clusterId !== story.clusterId;
              return !(s.type === story.type && s.id === story.id);
            }),
          };
        },
      );
      return { prev };
    },
    onError: (_err, _nextHidden, context) => {
      if (context?.prev !== undefined) {
        queryClient.setQueryData(["/api/curated/top-stories", { hours: 24, limit: 100 }], context.prev);
      }
      toast({ title: "Failed to update story visibility", variant: "destructive" });
    },
    onSuccess: (_data, nextHidden) => {
      queryClient.invalidateQueries({ queryKey: ["/api/curated/top-stories"] });
      toast({
        title: nextHidden ? "Story hidden" : "Story restored",
        description: nextHidden
          ? "Removed from the Curated view."
          : "Back in the Curated view.",
      });
      onChanged?.();
    },
  });

  const doToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    mutation.mutate(!hidden);
  };

  if (variant === "icon") {
    return (
      <Button
        size="icon"
        variant="ghost"
        onClick={doToggle}
        disabled={mutation.isPending}
        title={hidden ? "Un-hide story" : "Hide story"}
        className="text-curated-accent-strong"
        data-testid={`button-hide-story-${story.id}`}
      >
        {mutation.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : hidden ? (
          <Eye className="h-4 w-4" />
        ) : (
          <EyeOff className="h-4 w-4" />
        )}
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={doToggle}
      disabled={mutation.isPending}
      data-testid={`button-hide-story-${story.id}`}
    >
      {mutation.isPending ? (
        <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
      ) : hidden ? (
        <Eye className="h-3.5 w-3.5 mr-1.5" />
      ) : (
        <EyeOff className="h-3.5 w-3.5 mr-1.5" />
      )}
      {hidden ? "Un-hide" : "Hide story"}
    </Button>
  );
}

// All URLs that identify a story for the manual-link overlay: its representative
// URL plus every cluster member's URL. Sent to the server so the clustering
// must-link can tie the linked items together no matter which one is present.
function storyIdentityUrls(s: CuratedStory): string[] {
  const urls = [s.url, ...((s.members ?? []).map((m) => m.url))];
  return Array.from(new Set(urls.filter((u): u is string => !!u)));
}

const storyKey = (s: { type: string; id: string }) => `${s.type}:${s.id}`;

// Allowlist-gated EDITOR MANUAL LINK / MERGE (Task #430). Rendered ONLY to
// curated editors in the story detail pop-out. Lets the editor deliberately fold
// THIS story together with one or more OTHER current Top Stories into a single
// story — either LINK a stray item into an existing story (one target) or MERGE
// several (multiple targets). An AI gives a non-binding second opinion (concur /
// object-with-reason); the EDITOR always decides. Every action is written to the
// curated_manual_links overlay, which both drives the clustering must-link and is
// the Source Oversight editor-update audit trail. Curated view only.
function CuratedManualLinkControl({ story }: { story: CuratedStory }) {
  const { toast } = useToast();
  const tz = useTimezone();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [verdict, setVerdict] = useState<"concur" | "object" | "skipped" | null>(null);
  const [reasoning, setReasoning] = useState<string>("");
  const [reviewWarning, setReviewWarning] = useState<string>("");
  const [reviewToken, setReviewToken] = useState<string | null>(null);
  const [search, setSearch] = useState<string>("");
  const [selectedReasons, setSelectedReasons] = useState<Set<string>>(new Set());
  const [reasonNote, setReasonNote] = useState<string>("");

  // Read the SAME cached Top Stories list the page already fetched; offer every
  // OTHER story as a link/merge target.
  const { data: topStoriesData } = useQuery<{ stories?: CuratedStory[] }>({
    queryKey: ["/api/curated/top-stories", { hours: 24, limit: 100 }],
  });
  // Scoring-radar data — fetched lazily only while the dialog is open so an
  // editor can search below-cut items that haven't surfaced yet.
  const { data: radarData } = useQuery<RadarPayload>({
    queryKey: ["/api/curated/scoring-radar"],
    enabled: open,
    staleTime: 15_000,
  });
  // Social/official posts for the third candidate group — attach-only ride-alongs
  // (X, Truth Social, OSINT, journalist, DataMinr). Fetched lazily while open.
  const { data: socialData } = useQuery<SocialLinkCandidate[]>({
    queryKey: ["/api/curated/social-link-candidates"],
    enabled: open,
    staleTime: 15_000,
  });

  const candidates = (topStoriesData?.stories ?? []).filter(
    (s) => storyKey(s) !== storyKey(story),
  );

  // Normalized URL set for the top-stories pool — used to deduplicate below-cut
  // radar items so the same article never appears twice in the list.
  const topStoryUrls = useMemo(() => {
    const urls = new Set<string>();
    for (const s of candidates) {
      if (s.url) {
        try { urls.add(new URL(s.url).pathname + new URL(s.url).search); } catch { urls.add(s.url); }
      }
      for (const m of s.members ?? []) {
        if (m.url) {
          try { urls.add(new URL(m.url).pathname + new URL(m.url).search); } catch { urls.add(m.url); }
        }
      }
    }
    return urls;
  }, [candidates]);

  // Build search text for a CuratedStory — delegates to the module-level
  // buildStorySearchText so the dialog and global search stay in lockstep.
  const storyToSearchText = (s: CuratedStory): string => buildStorySearchText(s);

  // Build search text for a RadarItem — same field set as buildStorySearchText,
  // minus cluster members (below-cut items are individual rows, not clusters).
  const radarToSearchText = (r: RadarItem): string => {
    const parts: (string | null | undefined)[] = [
      r.title, r.source, r.category, r.primaryTopic,
      r.region, r.country, r.conflictTrack, r.summary,
    ];
    if (r.summaryBullets) parts.push(...r.summaryBullets);
    if (r.facts) parts.push(...r.facts);
    if (r.attributedClaims) parts.push(...r.attributedClaims);
    if (r.matchedKeywords) parts.push(...r.matchedKeywords);
    if (r.countryPair) parts.push(...r.countryPair);
    return parts.filter((p): p is string => !!p).join(" \u241f ").toLowerCase();
  };

  // Pre-build search text for all top-story candidates (memoized so the
  // enriched field scan doesn't re-run on every keystroke).
  const candidateSearchTexts = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of candidates) map.set(storyKey(s), storyToSearchText(s));
    return map;
  // storyToSearchText is stable (pure fn, no external deps) — only re-run when candidates changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates]);

  // Content tokens extracted from the source item's headline — used to rank
  // candidates by relevance to the item being linked (not by priority score).
  const sourceTokens = useMemo(
    () => tokenizeForLink(story.headline || story.displayTitle || story.title),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [story.id],
  );

  // Below-cut radar candidates: non-surfacing items not already in the
  // top-stories pool (deduplicated by URL path). Shown only when a search
  // query is active to avoid an overwhelming default list.
  const radarCandidates = useMemo((): RadarItem[] => {
    if (!radarData?.items) return [];
    return radarData.items.filter((r) => {
      if (r.surfacingState === 'surfacing') return false; // already in top-stories pool
      // Skip if already represented in top-stories by URL
      if (r.url) {
        let key = r.url;
        try { key = new URL(r.url).pathname + new URL(r.url).search; } catch { /* use raw */ }
        if (topStoryUrls.has(key)) return false;
      }
      // Skip the dialog's own story
      if (`${r.type}:${r.id}` === storyKey(story)) return false;
      return true;
    });
  }, [radarData, topStoryUrls, story]);

  // Pre-build search text for all radar candidates (memoized).
  const radarSearchTexts = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of radarCandidates) map.set(`${r.type}:${r.id}`, radarToSearchText(r));
    return map;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radarCandidates]);

  // Enriched multi-term AND filter/rank — all terms must appear in the search
  // text (AND logic). Already-selected items always stay visible. When no query
  // is active, candidates are ranked by token overlap with the source item's
  // headline (most relevant first) instead of raw priority-score order. When a
  // query is typed, matching items are ranked by match quality (title hit = 3×,
  // body/metadata hit = 1×) so the closest match surfaces first.
  const q = search.trim().toLowerCase();
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];

  const visibleCandidates = useMemo(() => {
    if (!terms.length) {
      // Default view: rank by relevance to the source item, tie-break by
      // source count so bigger stories float up within the same relevance band.
      if (!sourceTokens.length) return candidates;
      return [...candidates].sort((a, b) => {
        const aTitle = (a.headline || a.displayTitle || a.title || "").toLowerCase();
        const bTitle = (b.headline || b.displayTitle || b.title || "").toLowerCase();
        const aBody  = candidateSearchTexts.get(storyKey(a)) ?? "";
        const bBody  = candidateSearchTexts.get(storyKey(b)) ?? "";
        const aScore = scoreCandidateVsSource(sourceTokens, aTitle, aBody);
        const bScore = scoreCandidateVsSource(sourceTokens, bTitle, bBody);
        if (bScore !== aScore) return bScore - aScore;
        return (b.sourceCount ?? 0) - (a.sourceCount ?? 0);
      });
    }
    // Search mode: AND-filter + rank by match quality.
    const scored: Array<{ s: CuratedStory; score: number }> = [];
    for (const s of candidates) {
      const key  = storyKey(s);
      const text = candidateSearchTexts.get(key) ?? "";
      if (!selected.has(key) && !terms.every((t) => text.includes(t))) continue;
      const titleText = (s.headline || s.displayTitle || s.title || "").toLowerCase();
      let score = selected.has(key) ? 1e9 : 0; // selected items always float first
      for (const t of terms) {
        if (titleText.includes(t)) score += 3;
        else if (text.includes(t)) score += 1;
      }
      scored.push({ s, score });
    }
    return scored.sort((a, b) => b.score - a.score).map((x) => x.s);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, terms, selected, candidateSearchTexts, sourceTokens]);

  // Visible below-cut radar candidates — shown when a search query is active
  // OR when at least one radar item is already selected (so a selection never
  // disappears if the editor clears the query after picking an item).
  const visibleRadarCandidates = useMemo(() => {
    const hasSelectedRadar = radarCandidates.some((r) => selected.has(`${r.type}:${r.id}`));
    if (!terms.length && !hasSelectedRadar) return [];
    return radarCandidates.filter((r) => {
      const k = `${r.type}:${r.id}`;
      if (selected.has(k)) return true;       // always keep selected picks
      if (!terms.length) return false;         // no query, show only selected
      return terms.every((t) => (radarSearchTexts.get(k) ?? "").includes(t));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radarCandidates, terms, selected, radarSearchTexts]);

  // Social/official post candidate key — unique within the `selected` Set.
  const socialKey = (c: SocialLinkCandidate) => `social:${c.laneType}:${c.id}`;

  // Browser-side mirror of server/urlIdentity.ts. It deliberately preserves
  // unknown query params (social post IDs are identity) while removing only
  // tracking keys, sorting kept params, dropping fragments, and lowercasing.
  // The server remains authoritative; this only prevents an already-attached
  // social post from being offered again before the next refresh.
  const normSocialUrl = normalizeCuratedIdentityUrl;

  const storyMemberUrls = useMemo(() => {
    const set = new Set<string>();
    if (story.url) set.add(normSocialUrl(story.url));
    for (const m of story.members ?? []) { if (m.url) set.add(normSocialUrl(m.url)); }
    return set;
  }, [story.url, story.members]);

  // Social candidates: posts from all social lanes not already in this story.
  // Deduplicated by normalized URL (strips tracking params, mirrors server normalizeIdentityUrl).
  const socialCandidates = useMemo((): SocialLinkCandidate[] => {
    if (!socialData) return [];
    const seen = new Set<string>();
    return socialData.filter((c) => {
      if (!c.url) return false;
      const norm = normSocialUrl(c.url);
      if (storyMemberUrls.has(norm)) return false;
      if (seen.has(norm)) return false;
      seen.add(norm);
      return true;
    });
  }, [socialData, storyMemberUrls]);

  // Social candidate search texts (memoized so the filter doesn't re-run per keystroke).
  const socialSearchTexts = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of socialCandidates) {
      map.set(socialKey(c), `${c.source} ${c.snippet}`.toLowerCase());
    }
    return map;
  // socialKey is stable (pure fn) — only re-run when socialCandidates changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socialCandidates]);

  // Social posts are browseable by default. Unlike the broad radar list, this
  // feed is bounded and is exactly the official/Truth coverage editors need to
  // attach; requiring a guessed keyword hid valid posts in normal use.
  const visibleSocialCandidates = useMemo((): SocialLinkCandidate[] => {
    return socialCandidates.filter((c) => {
      const k = socialKey(c);
      if (selected.has(k)) return true;
      if (!terms.length) return true;
      return terms.every((t) => (socialSearchTexts.get(k) ?? "").includes(t));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socialCandidates, terms, selected, socialSearchTexts]);

  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setVerdict(null);
      setReasoning("");
      setReviewWarning("");
      setReviewToken(null);
      setSearch("");
      setSelectedReasons(new Set());
      setReasonNote("");
    }
  }, [open]);

  const selectedStories = candidates.filter((s) => selected.has(storyKey(s)));
  const selectedRadarItems = radarCandidates.filter((r) => selected.has(`${r.type}:${r.id}`));
  const selectedSocialItems = socialCandidates.filter((c) => selected.has(socialKey(c)));
  // Count only real news stories/radar items toward kind='merge'; social items
  // are attach-only and must never trigger the formation-gate bypass.
  const totalRealSelected = selectedStories.length + selectedRadarItems.length;
  const selectedMemberUrls = Array.from(
    new Set([
      ...storyIdentityUrls(story),
      ...selectedStories.flatMap(storyIdentityUrls),
      ...selectedRadarItems.map((r) => r.url).filter((u): u is string => !!u),
      ...selectedSocialItems.map((c) => c.url).filter((u): u is string => !!u),
    ]),
  );

  const toggleStory = (s: CuratedStory) => {
    setVerdict(null);
    setReasoning("");
    setReviewWarning("");
    setReviewToken(null);
    setSelected((prev) => {
      const next = new Set(prev);
      const k = storyKey(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const toggleRadar = (r: RadarItem) => {
    setVerdict(null);
    setReasoning("");
    setReviewWarning("");
    setReviewToken(null);
    setSelected((prev) => {
      const next = new Set(prev);
      const k = `${r.type}:${r.id}`;
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const toggleSocial = (c: SocialLinkCandidate) => {
    setVerdict(null);
    setReasoning("");
    setReviewWarning("");
    setReviewToken(null);
    setSelected((prev) => {
      const next = new Set(prev);
      const k = socialKey(c);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const asItem = (s: CuratedStory) => ({
    title: s.headline || s.displayTitle || s.title,
    outlet: s.sourceCount > 1 ? `${s.sourceCount} sources` : s.source,
    url: s.url,
  });

  const asRadarItem = (r: RadarItem) => ({
    title: r.title,
    outlet: r.source,
    url: r.url,
  });

  const asSocialItem = (c: SocialLinkCandidate) => ({
    title: c.snippet,
    outlet: `@${c.source}`,
    url: c.url,
  });

  const review = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/curated/link-review", {
        items: [
          asItem(story),
          ...selectedStories.map(asItem),
          ...selectedRadarItems.map(asRadarItem),
          ...selectedSocialItems.map(asSocialItem),
        ],
        memberUrls: selectedMemberUrls,
      });
      return res.json() as Promise<{
        verdict: "concur" | "object" | "skipped";
        reasoning: string;
        warning?: string | null;
        reviewToken?: string;
      }>;
    },
    onSuccess: (data) => {
      setVerdict(data.verdict);
      setReasoning(data.reasoning || "");
      setReviewWarning(data.warning || "");
      setReviewToken(data.reviewToken || null);
    },
    onError: () => {
      // Fail open — never block the editor on AI.
      setVerdict("skipped");
      setReasoning("AI review unavailable.");
      setReviewWarning("");
      setReviewToken(null);
    },
  });

  const commit = useMutation({
    mutationFn: async () => {
      const memberUrls = selectedMemberUrls;
      // Social items are attach-only — never trigger kind='merge'. Use the
      // component-level totalRealSelected (only real news stories / radar items).
      const kind = totalRealSelected > 1 ? "merge" : "link";
      const res = await apiRequest("POST", "/api/curated/link-items", {
        memberUrls,
        kind,
        label: story.headline || story.displayTitle || story.title,
        reviewToken,
        reviewUrls: selectedMemberUrls,
        reasonKeys: Array.from(selectedReasons),
        reasonNote: reasonNote.trim() || null,
      });
      return res.json() as Promise<{ ok: boolean; reshaped?: boolean; formed?: boolean; deferred?: boolean }>;
    },
    onMutate: async () => {
      // Optimistic update: immediately collapse the selected stories into the
      // primary story card so the editor sees the merge without waiting for the
      // server round-trip. Reconciled with real server data on the next poll.
      await queryClient.cancelQueries({ queryKey: ["/api/curated/top-stories"] });
      const prev = queryClient.getQueryData<{ stories?: CuratedStory[] }>(["/api/curated/top-stories", { hours: 24, limit: 100 }]);
      const mergedKeys = new Set(selectedStories.map(storyKey));
      if (prev?.stories) {
        const mergedSourceCount = selectedStories.reduce(
          (sum, s) => sum + Math.max(1, s.sourceCount || 1),
          Math.max(1, story.sourceCount || 1),
        );
        const optimisticStories = prev.stories
          .filter((s) => !mergedKeys.has(storyKey(s)))
          .map((s) =>
            storyKey(s) === storyKey(story)
              ? { ...s, sourceCount: mergedSourceCount, _grouping: true }
              : s,
          );
        queryClient.setQueryData(["/api/curated/top-stories", { hours: 24, limit: 100 }], {
          ...prev,
          stories: optimisticStories,
        });
      }
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev !== undefined) {
        queryClient.setQueryData(["/api/curated/top-stories", { hours: 24, limit: 100 }], context.prev);
      }
      toast({ title: "Failed to link items", variant: "destructive" });
    },
    onSuccess: (data) => {
      // The editor manual-link record is written server-side immediately (even on
      // the deferred path), so always refresh the editor trail.
      queryClient.invalidateQueries({ queryKey: ["/api/curated/manual-links"] });
      if (data?.deferred) {
        // Clustering was mid-pass, so the merge is queued and applies the instant
        // that pass finishes. Do NOT refetch top-stories now: the server hasn't
        // regrouped yet, and a refetch would snap the optimistically-collapsed
        // cards back apart (the "instant collapse cancels itself out" bug). Keep
        // the optimistic merge on screen; the ~12s revision poll auto-refetches
        // once the deferred re-shape lands and bumps the curated revision.
        toast({
          title: "Link saved — grouping in progress",
          description:
            "Recorded to the editor trail. The merge stays on screen and fills in automatically once the current clustering pass finishes.",
        });
      } else {
        // Applied synchronously, or definitively not formed — pull the
        // authoritative list now (reverting the optimistic view if it didn't form).
        queryClient.invalidateQueries({ queryKey: ["/api/curated/top-stories"] });
        queryClient.invalidateQueries({ queryKey: ["/api/curated/cluster-members"] });
        if (data?.reshaped && data?.formed === false) {
          toast({
            title: "Saved, but not grouped yet",
            description:
              "The link was recorded, but these items don't yet meet the formation requirement (at least 2 corroborating sources). They'll merge automatically once that's met.",
          });
        } else {
          toast({
            title: "Items linked",
            description:
              "Grouping applied — headline will refresh shortly.",
          });
        }
      }
      setOpen(false);
    },
  });

  const busy = review.isPending || commit.isPending;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                onClick={(e) => e.stopPropagation()}
                className="text-curated-accent-strong"
                data-testid={`button-link-story-${story.id}`}
              >
                <Combine className="h-4 w-4" />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Link / merge stories</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DialogContent
        className="curated-surface bg-background text-foreground border-2 border-curated-accent/50 max-w-xl w-[95vw] max-h-[85vh] overflow-y-auto"
        data-testid="dialog-manual-link"
        onClick={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>Link or merge into one story</DialogTitle>
          <DialogDescription>
            Pick one story to link this item into, or several to merge them all
            together. An AI will give its opinion, but you decide. Every action is
            logged for the Source Oversight review.
          </DialogDescription>
        </DialogHeader>

        <div className="text-sm text-curated-muted font-mono px-1 py-2 border border-border rounded-md">
          <span className="text-curated-accent-strong">This item:</span>{" "}
          {story.headline || story.displayTitle || story.title}
        </div>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search stories by keyword…"
            className="pl-8"
            data-testid="input-search-link-targets"
          />
        </div>

        <div className="max-h-64 overflow-y-auto divide-y divide-border rounded-md border border-border" data-testid="list-link-targets">
          {candidates.length === 0 && (
            <div className="p-3 text-sm text-muted-foreground">No other stories available.</div>
          )}
          {candidates.length === 0 && socialCandidates.length === 0 && (
            <div className="p-3 text-sm text-muted-foreground">
              {socialData ? "No linkable stories or social posts are available." : "Loading link candidates…"}
            </div>
          )}
          {(candidates.length > 0 || socialCandidates.length > 0) && visibleCandidates.length === 0 && visibleRadarCandidates.length === 0 && visibleSocialCandidates.length === 0 && (
            <div className="p-3 text-sm text-muted-foreground" data-testid="text-no-search-matches">
              No stories match “{search.trim()}”.
            </div>
          )}
          {visibleCandidates.map((s) => {
            const active = selected.has(storyKey(s));
            const headline = s.headline || s.displayTitle || s.title;
            const context = formatNewsCandidateContext({
              source: s.source,
              sourceCount: s.sourceCount,
              articlePublishedAt: s.sourceCount > 1 ? null : s.articlePublishedAt,
              firstSeenAt: s.sourceCount > 1 ? null : s.scrapedAt,
              // Cluster articlePublishedAt is the server's honest synopsis
              // synthesized-through/update timestamp.
              updatedAt: s.sourceCount > 1 ? s.articlePublishedAt : null,
            }, tz);
            return (
              <button
                key={storyKey(s)}
                type="button"
                onClick={() => toggleStory(s)}
                className="w-full text-left flex items-start gap-2 p-2 hover-elevate"
                data-testid={`option-link-target-${s.id}`}
              >
                <span className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border border-border flex items-center justify-center">
                  {active && <Check className="h-3 w-3 text-curated-accent-strong" />}
                </span>
                <span className="min-w-0 flex-1">
                  <OverflowHeadlineTooltip
                    text={headline}
                    className="block text-sm leading-snug truncate"
                    testId={`text-link-target-headline-${s.id}`}
                  />
                  <span className="block text-xs text-muted-foreground font-mono">
                    {context}
                  </span>
                </span>
              </button>
            );
          })}
          {/* Below-cut radar items — shown only when a search query is active,
              after the top-stories results, with a visual "not surfacing" tag. */}
          {visibleSocialCandidates.length > 0 && (
            <>
              <div className="px-2 py-1 text-[10px] text-muted-foreground/60 font-mono uppercase tracking-wide select-none flex items-center gap-1.5">
                Official &amp; social posts
                <span className="px-1 py-0 rounded border border-[#5FA8C4]/40 text-[#5FA8C4]/70 leading-none">
                  attach-only
                </span>
              </div>
              {visibleSocialCandidates.map((c) => {
                const k = socialKey(c);
                const active = selected.has(k);
                const laneBadge: Record<SocialLinkCandidate["laneType"], string> = {
                  x: "X/Official",
                  osint: "OSINT",
                  journalist: "Journalist",
                  truth: "Truth Social",
                  dataminr: "DataMinr",
                  response: "Response",
                  sentdefender: "SentDefender",
                };
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => toggleSocial(c)}
                    className="w-full text-left flex items-start gap-2 p-2 hover-elevate"
                    data-testid={`option-link-target-social-${c.id}`}
                  >
                    <span className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border border-border flex items-center justify-center">
                      {active && <Check className="h-3 w-3 text-[#5FA8C4]" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm leading-snug line-clamp-2">
                          {c.snippet}
                        </span>
                        <span
                          className="shrink-0 text-[10px] px-1 py-0.5 rounded border border-[#5FA8C4]/30 text-[#5FA8C4]/70 font-mono leading-none"
                          data-testid={`badge-social-lane-${c.id}`}
                        >
                          {laneBadge[c.laneType] ?? c.laneType}
                        </span>
                      </span>
                      <span className="block text-xs text-muted-foreground font-mono">
                        @{c.source}{c.postedAt ? ` · ${timeAgo(c.postedAt)}` : ""}
                      </span>
                    </span>
                  </button>
                );
              })}
            </>
          )}
          {visibleRadarCandidates.length > 0 && (
            <>
              {visibleCandidates.length > 0 && (
                <div className="px-2 py-1 text-[10px] text-muted-foreground/60 font-mono uppercase tracking-wide select-none">
                  Not currently surfacing
                </div>
              )}
              {visibleRadarCandidates.map((r) => {
                const k = `${r.type}:${r.id}`;
                const active = selected.has(k);
                const stateLabel = RADAR_STATE_LABELS[r.surfacingState] ?? r.surfacingState;
                const context = formatNewsCandidateContext({
                  source: r.source,
                  articlePublishedAt: r.articlePublishedAt,
                  firstSeenAt: r.firstSeenAt,
                }, tz);
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => toggleRadar(r)}
                    className="w-full text-left flex items-start gap-2 p-2 hover-elevate"
                    data-testid={`option-link-target-radar-${r.id}`}
                  >
                    <span className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border border-border flex items-center justify-center">
                      {active && <Check className="h-3 w-3 text-[#5FA8C4]" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <OverflowHeadlineTooltip
                          text={r.title}
                          className="min-w-0 flex-1 text-sm leading-snug truncate"
                          testId={`text-link-target-radar-headline-${r.id}`}
                        />
                        <span
                          className="shrink-0 text-[10px] px-1 py-0.5 rounded border border-amber-500/40 text-amber-400/80 font-mono leading-none"
                          data-testid={`badge-below-cut-${r.id}`}
                        >
                          {stateLabel}
                        </span>
                      </span>
                      <span className="block text-xs text-muted-foreground font-mono">
                        {context}
                      </span>
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>

        {verdict && (
          <div className="rounded-md border border-border p-3 space-y-1" data-testid="text-ai-verdict">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground font-mono">AI opinion:</span>
              <Badge
                variant={verdict === "object" ? "destructive" : "outline"}
                data-testid="badge-ai-verdict"
              >
                {verdict === "concur" ? "Concurs" : verdict === "object" ? "Objects" : "No opinion"}
              </Badge>
            </div>
            {reasoning && <p className="text-sm text-curated-muted">{reasoning}</p>}
            {reviewWarning && (
              <p className="text-xs text-amber-500" data-testid="text-ai-review-warning">
                {reviewWarning}
              </p>
            )}
          </div>
        )}

        {/* Optional reason checkboxes — shown once the editor has selected at
            least one target. Selecting zero reasons is fine. */}
        {selected.size > 0 && (
          <div className="space-y-2" data-testid="section-link-reasons">
            <p className="text-xs text-muted-foreground">
              Why are you linking these? (optional — helps tune clustering)
            </p>
            <div className="flex flex-wrap gap-2">
              {LINK_MERGE_REASONS.map((r) => {
                const active = selectedReasons.has(r.key);
                return (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() =>
                      setSelectedReasons((prev) => {
                        const next = new Set(prev);
                        if (next.has(r.key)) next.delete(r.key);
                        else next.add(r.key);
                        return next;
                      })
                    }
                    className={`text-xs px-2 py-1 rounded-md border transition-colors ${
                      active
                        ? "bg-curated-accent/20 border-curated-accent text-curated-accent-strong"
                        : "border-border text-muted-foreground hover:border-curated-accent/50"
                    }`}
                    data-testid={`chip-link-reason-${r.key}`}
                  >
                    {r.label}
                  </button>
                );
              })}
            </div>
            <Textarea
              placeholder="Quick note (optional)…"
              value={reasonNote}
              onChange={(e) => setReasonNote(e.target.value)}
              className="text-xs resize-none h-14"
              maxLength={500}
              data-testid="input-link-reason-note"
            />
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={selected.size === 0 || busy}
            onClick={() => review.mutate()}
            data-testid="button-get-ai-opinion"
          >
            {review.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <MessageSquareQuote className="h-4 w-4 mr-1.5" />
            )}
            Get AI opinion
          </Button>
          <Button
            variant="curated"
            disabled={selected.size === 0 || busy}
            onClick={() => commit.mutate()}
            data-testid="button-confirm-link"
          >
            {commit.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <Combine className="h-4 w-4 mr-1.5" />
            )}
            {verdict === "object"
              ? "Link anyway"
              : totalRealSelected > 1
                ? `Merge ${totalRealSelected + 1} items`
                : "Link into story"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Top Stories header — bulk link/merge for a set of stories picked via the
// header's "Select" mode (Task #643). Same editor flow as
// CuratedManualLinkControl (optional AI second opinion, then commit via the
// same /api/curated/link-review + /api/curated/link-items endpoints, same
// audit logging) but driven by an already-picked set instead of a one-story
// picker. Curated-lane only; AI is advisory and never blocks the editor.
function TopStoriesLinkMergeControl({
  stories,
  onDone,
}: {
  stories: CuratedStory[];
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<"concur" | "object" | "skipped" | null>(null);
  const [reasoning, setReasoning] = useState<string>("");
  const [reviewWarning, setReviewWarning] = useState<string>("");
  const [reviewToken, setReviewToken] = useState<string | null>(null);
  const [selectedReasons, setSelectedReasons] = useState<Set<string>>(new Set());
  const [reasonNote, setReasonNote] = useState<string>("");

  useEffect(() => {
    if (!open) {
      setVerdict(null);
      setReasoning("");
      setReviewWarning("");
      setReviewToken(null);
      setSelectedReasons(new Set());
      setReasonNote("");
    }
  }, [open]);

  const asItem = (s: CuratedStory) => ({
    title: s.headline || s.displayTitle || s.title,
    outlet: s.sourceCount > 1 ? `${s.sourceCount} sources` : s.source,
    url: s.url,
  });
  const selectedMemberUrls = Array.from(new Set(stories.flatMap(storyIdentityUrls)));

  const review = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/curated/link-review", {
        items: stories.map(asItem),
        memberUrls: selectedMemberUrls,
      });
      return res.json() as Promise<{
        verdict: "concur" | "object" | "skipped";
        reasoning: string;
        warning?: string | null;
        reviewToken?: string;
      }>;
    },
    onSuccess: (data) => {
      setVerdict(data.verdict);
      setReasoning(data.reasoning || "");
      setReviewWarning(data.warning || "");
      setReviewToken(data.reviewToken || null);
    },
    onError: () => {
      // Fail open — never block the editor on AI.
      setVerdict("skipped");
      setReasoning("AI review unavailable.");
      setReviewWarning("");
      setReviewToken(null);
    },
  });

  const commit = useMutation({
    mutationFn: async () => {
      const memberUrls = selectedMemberUrls;
      const kind = stories.length === 2 ? "link" : "merge";
      const res = await apiRequest("POST", "/api/curated/link-items", {
        memberUrls,
        kind,
        label: stories[0]?.headline || stories[0]?.displayTitle || stories[0]?.title || "",
        reviewToken,
        reviewUrls: selectedMemberUrls,
        reasonKeys: Array.from(selectedReasons),
        reasonNote: reasonNote.trim() || null,
      });
      return res.json() as Promise<{ ok: boolean; reshaped?: boolean; formed?: boolean; deferred?: boolean }>;
    },
    onMutate: async () => {
      // Optimistic update: immediately collapse all selected stories into the
      // first one so the editor sees the merge without waiting for the server.
      // Reconciled with real server data on the next poll.
      await queryClient.cancelQueries({ queryKey: ["/api/curated/top-stories"] });
      const prev = queryClient.getQueryData<{ stories?: CuratedStory[] }>(["/api/curated/top-stories", { hours: 24, limit: 100 }]);
      const primaryKey = stories[0] ? storyKey(stories[0]) : null;
      const removedKeys = new Set(stories.slice(1).map(storyKey));
      if (prev?.stories && primaryKey) {
        const mergedSourceCount = stories.reduce(
          (sum, s) => sum + Math.max(1, s.sourceCount || 1),
          0,
        );
        const optimisticStories = prev.stories
          .filter((s) => !removedKeys.has(storyKey(s)))
          .map((s) =>
            storyKey(s) === primaryKey
              ? { ...s, sourceCount: mergedSourceCount, _grouping: true }
              : s,
          );
        queryClient.setQueryData(["/api/curated/top-stories", { hours: 24, limit: 100 }], {
          ...prev,
          stories: optimisticStories,
        });
      }
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev !== undefined) {
        queryClient.setQueryData(["/api/curated/top-stories", { hours: 24, limit: 100 }], context.prev);
      }
      toast({ title: "Failed to link items", variant: "destructive" });
    },
    onSuccess: (data) => {
      // The editor manual-link record is written server-side immediately (even on
      // the deferred path), so always refresh the editor trail.
      queryClient.invalidateQueries({ queryKey: ["/api/curated/manual-links"] });
      if (data?.deferred) {
        // Clustering was mid-pass, so the merge is queued and applies the instant
        // that pass finishes. Do NOT refetch top-stories now: the server hasn't
        // regrouped yet, and a refetch would snap the optimistically-collapsed
        // cards back apart (the "instant collapse cancels itself out" bug). Keep
        // the optimistic merge on screen; the ~12s revision poll auto-refetches
        // once the deferred re-shape lands and bumps the curated revision.
        toast({
          title: "Link saved — grouping in progress",
          description:
            "Recorded to the editor trail. The merge stays on screen and fills in automatically once the current clustering pass finishes.",
        });
      } else {
        // Applied synchronously, or definitively not formed — pull the
        // authoritative list now (reverting the optimistic view if it didn't form).
        queryClient.invalidateQueries({ queryKey: ["/api/curated/top-stories"] });
        queryClient.invalidateQueries({ queryKey: ["/api/curated/cluster-members"] });
        if (data?.reshaped && data?.formed === false) {
          toast({
            title: "Saved, but not grouped yet",
            description:
              "The link was recorded, but these items don't yet meet the formation requirement (at least 2 corroborating sources). They'll merge automatically once that's met.",
          });
        } else {
          toast({
            title: "Items linked",
            description:
              "Grouping applied — headline will refresh shortly.",
          });
        }
      }
      setOpen(false);
      onDone();
    },
  });

  const busy = review.isPending || commit.isPending;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="curated"
          disabled={stories.length < 2}
          data-testid="button-top-stories-link-merge"
        >
          <Combine className="h-3.5 w-3.5 mr-1.5" />
          Link / merge
        </Button>
      </DialogTrigger>
      <DialogContent
        className="curated-surface bg-background text-foreground border-2 border-curated-accent/50 max-w-xl w-[95vw] max-h-[85vh] overflow-y-auto"
        data-testid="dialog-top-stories-link-merge"
      >
        <DialogHeader>
          <DialogTitle>Link or merge {stories.length} selected stories</DialogTitle>
          <DialogDescription>
            An AI will give its opinion, but you decide. Every action is logged
            for the Source Oversight review.
          </DialogDescription>
        </DialogHeader>

        <div
          className="max-h-64 overflow-y-auto divide-y divide-border rounded-md border border-border"
          data-testid="list-top-stories-link-merge-selection"
        >
          {stories.map((s) => (
            <div key={storyKey(s)} className="p-2 text-sm" data-testid={`text-link-merge-item-${s.id}`}>
              <span className="block truncate">{s.headline || s.displayTitle || s.title}</span>
              <span className="block text-xs text-muted-foreground font-mono">
                {s.sourceCount > 1 ? `${s.sourceCount} sources` : s.source}
              </span>
            </div>
          ))}
        </div>

        {verdict && (
          <div className="rounded-md border border-border p-3 space-y-1" data-testid="text-top-stories-link-merge-verdict">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground font-mono">AI opinion:</span>
              <Badge
                variant={verdict === "object" ? "destructive" : "outline"}
                data-testid="badge-top-stories-link-merge-verdict"
              >
                {verdict === "concur" ? "Concurs" : verdict === "object" ? "Objects" : "No opinion"}
              </Badge>
            </div>
            {reasoning && <p className="text-sm text-curated-muted">{reasoning}</p>}
            {reviewWarning && (
              <p className="text-xs text-amber-500" data-testid="text-top-stories-ai-review-warning">
                {reviewWarning}
              </p>
            )}
          </div>
        )}

        {/* Optional reason checkboxes — always shown so editor can add context
            before clicking confirm. Selecting zero reasons is fine. */}
        <div className="space-y-2" data-testid="section-top-stories-link-reasons">
          <p className="text-xs text-muted-foreground">
            Why are you linking these? (optional)
          </p>
          <div className="flex flex-wrap gap-2">
            {LINK_MERGE_REASONS.map((r) => {
              const active = selectedReasons.has(r.key);
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={() =>
                    setSelectedReasons((prev) => {
                      const next = new Set(prev);
                      if (next.has(r.key)) next.delete(r.key);
                      else next.add(r.key);
                      return next;
                    })
                  }
                  className={`text-xs px-2 py-1 rounded-md border transition-colors ${
                    active
                      ? "bg-curated-accent/20 border-curated-accent text-curated-accent-strong"
                      : "border-border text-muted-foreground hover:border-curated-accent/50"
                  }`}
                  data-testid={`chip-top-stories-link-reason-${r.key}`}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
          <Textarea
            placeholder="Quick note (optional)…"
            value={reasonNote}
            onChange={(e) => setReasonNote(e.target.value)}
            className="text-xs resize-none h-14"
            maxLength={500}
            data-testid="input-top-stories-link-reason-note"
          />
        </div>

        <DialogFooter className="flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => review.mutate()}
            data-testid="button-top-stories-get-ai-opinion"
          >
            {review.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <MessageSquareQuote className="h-4 w-4 mr-1.5" />
            )}
            Get AI opinion
          </Button>
          <Button
            variant="curated"
            disabled={busy}
            onClick={() => commit.mutate()}
            data-testid="button-top-stories-confirm-link-merge"
          >
            {commit.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <Combine className="h-4 w-4 mr-1.5" />
            )}
            {verdict === "object"
              ? "Link anyway"
              : stories.length > 2
                ? `Merge ${stories.length} items`
                : "Link into story"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Allowlist-gated "Hidden stories" review panel (Task #380). Lists the stories an
// editor has taken off the Curated view and lets them UN-HIDE each one with a
// single click. Rendered only to editors (caller gates on hasAccess) and only
// when something is hidden. Un-hide hits the same curated endpoint with
// { hidden: false } using the SERVER-built key derived from scope/clusterId/id.
// ---------------------------------------------------------------------------
// Scoring Radar (Task #834) — EDITOR-ONLY panel showing recent curated items
// that are not surfacing in Top Stories, with gate-failure reasons and a
// one-click P-pin promote button. Regular viewers never see this component
// (it is gated on effectiveAccess before it is even rendered).
// ---------------------------------------------------------------------------
// Social/official post as a link-dialog candidate (Task #1036). The identity
// URL is the xUrl / truthSocialUrl — same value stored in curated_items.url.
type SocialLinkCandidate = {
  id: string;
  laneType: 'x' | 'osint' | 'journalist' | 'truth' | 'dataminr' | 'response' | 'sentdefender';
  source: string;
  snippet: string;
  url: string;
  postedAt: string;
};

type RadarItem = {
  id: string;
  type: 'curated' | 'main';
  url: string;
  title: string;
  source: string;
  priorityScore: number;
  decayedScore: number;
  itemAgeHours: number;
  // Honest time provenance for editor-only candidate context. A trustworthy
  // source publication date is never conflated with MCOP discovery time.
  articlePublishedAt?: string | null;
  firstSeenAt?: string | null;
  surfacingState: string;
  imageUrl?: string | null;
  contentKind?: string | null;
  category?: string | null;
  // Registry -cpc designation (contrast lane) — lets the editor separate
  // CPC vs non-CPC attach-only items.
  isCpc?: boolean;
  // A manual P-pin exists for this row — the editor already made a scoring
  // call, so the "scored too low" view excludes it (not an AI miss).
  hasManualOverride?: boolean;
  // Topic·Focus classification overlay (URL-keyed) — same vocabulary the Top
  // Stories cards use. Null/absent until the async classifier covers the row.
  primaryTopic?: string | null;
  country?: string | null;
  region?: string | null;
  conflictTrack?: string | null;
  countryPair?: string[] | null;
  // Rescue lifecycle (curated rows only — null for main-feed rows): persisted
  // enrichment back-off metadata + the server's in-process one-shot rescue
  // status, so 'not-enriched' rows show an honest pending/failed state.
  enrichmentAttempts?: number | null;
  lastEnrichmentAt?: string | null;
  enrichmentLifecycle?: 'ready' | 'pending' | 'backed-off' | 'retry-capped' | null;
  rescueStatus?: 'pending' | 'succeeded' | 'failed' | null;
  // Bridge-faithful auto-attach recommendation: computed server-side using the
  // SAME matching primitives as the incremental-attach bridge, so the panel
  // never over-promises. Present only on attach-only / opinion-video rows.
  attachRecommendation?: {
    reason: 'would-auto-attach' | 'ambiguous' | 'no-match' | 'manual-only';
    matchedClusterId?: string;
    matchCount: number;
  } | null;
  // Task #963: lone interrogative signal (trailing "?" or WH-lead) with no
  // corroborating URL/page signal. Shown as a "Possible explainer?" badge —
  // editor review prompt; never an auto-demotion trigger.
  possibleExplainer?: boolean;
  // Enriched content fields for the link/merge dialog search — same set as
  // the global storySearchText (bullets, corroborated facts, claims, keywords).
  summary?: string | null;
  summaryBullets?: string[] | null;
  attributedClaims?: string[] | null;
  facts?: string[] | null;
  matchedKeywords?: string[] | null;
};

type RadarPayload = {
  windowHours: number;
  feedLimit: number;
  cutLineScore: number;
  surfacingCount: number;
  radarCount: number;
  items: RadarItem[];
};

const RADAR_STATE_LABELS: Record<string, string> = {
  'below-cut':    'Below cut',
  'not-enriched': 'Not enriched',
  'age-out':      'Aged out',
  'attach-only':  'Attach-only',
  'opinion-video':'Opinion/Video',
};
const RADAR_STATE_ACTIONABLE = new Set(['below-cut', 'not-enriched']);

// Editor views only surface RECENT items — anything older than 12h is noise
// for a "should this be in Top Stories right now?" decision (user decision).
const EDITOR_VIEW_MAX_AGE_HOURS = 12;

// "Topic – Focus" metadata line for an editor-view row, reusing the SAME
// resolvers the Top Stories cards use (storyTopicLabel / focusLabel) so the
// vocabulary can never drift. Returns null when neither slot resolves to a
// meaningful value, so unclassified rows stay clean instead of showing
// "— – Global" filler.
function editorTopicFocus(item: RadarItem): string | null {
  const topic = storyTopicLabel({
    primaryTopic: item.primaryTopic ?? null,
    category: item.category ?? "",
    title: item.title,
  });
  const focus = focusLabel({
    title: item.title,
    summary: "",
    country: item.country ?? null,
    region: item.region ?? null,
    conflictTrack: item.conflictTrack ?? null,
    countryPair: item.countryPair ?? null,
  } as unknown as CuratedStory).label;
  const t = topic !== "—" ? topic : null;
  const f = focus && focus !== "Global" ? focus : null;
  if (!t && !f) return null;
  return [t, f].filter(Boolean).join(" – ");
}

// Hyperlinked title for editor-view rows — opens the source article in a new
// tab so the editor can check the piece before promoting / attaching.
function EditorItemTitle({ url, title, testId }: { url?: string | null; title: string; testId: string }) {
  if (!url) {
    return <p className="text-sm truncate" data-testid={testId}>{title}</p>;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block text-sm truncate hover:underline"
      onClick={(e) => e.stopPropagation()}
      data-testid={testId}
    >
      {title}
      <ExternalLink className="inline h-3 w-3 ml-1 align-baseline text-muted-foreground/60" />
    </a>
  );
}

// Best token-overlap suggestion for "which formed story could this item
// join?". Pure client-side title-token match (≥2 shared tokens) — the same
// heuristic the attach-candidates view has always used, now shared.
function bestClusterMatch(
  item: RadarItem,
  clusterTokens: { c: CuratedStory; tokens: Set<string> }[],
): CuratedStory | null {
  const t = linkTitleTokens(item.title);
  let best: { c: CuratedStory; n: number } | null = null;
  for (const { c, tokens } of clusterTokens) {
    let n = 0;
    t.forEach((w) => { if (tokens.has(w)) n++; });
    if (n >= 2 && (!best || n > best.n)) best = { c, n };
  }
  return best?.c ?? null;
}

// Shared attach mutation for BOTH editor views — links an item into a formed
// story WITHOUT touching its score (attach-only tier rules still apply
// downstream; a low-scored contributing item joins as ordinary coverage).
// Rides the existing manual-link overlay (must-link + audit + telemetry).
function useAttachToClusterMutation(setLinking: (id: string | null) => void) {
  const { toast } = useToast();
  return useMutation({
    mutationFn: async ({ item, cluster }: { item: RadarItem; cluster: CuratedStory }) => {
      const res = await apiRequest('POST', '/api/curated/link-items', {
        memberUrls: [item.url, cluster.url],
        kind: 'link',
        aiVerdict: 'skipped',
        label: (cluster.displayTitle || cluster.title || '').slice(0, 200),
        // Editor-view telemetry — lets the learning loop distinguish
        // view-prompted attaches from organic manual links.
        fromRadar: true,
        surfacingState: item.surfacingState,
      });
      return res.json();
    },
    onMutate: ({ item }) => setLinking(item.id),
    onSettled: () => setLinking(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/curated/top-stories'] });
      queryClient.invalidateQueries({ queryKey: ['/api/curated/scoring-radar'] });
      queryClient.invalidateQueries({ queryKey: ['/api/curated/attach-targets'] });
      toast({ title: 'Attached', description: 'Item linked into the story — coverage updates on the next re-shape.' });
    },
    onError: () => {
      toast({ title: 'Failed to attach', variant: 'destructive' });
    },
  });
}

// Popover cluster picker used by BOTH editor views: attach an item into ANY
// currently-formed story, with the token-match suggestion (when present)
// listed first. Keeps the row compact — one "Attach" button, full choice.
function AttachClusterPicker({
  item, suggestedId, pending, onAttach,
}: {
  item: RadarItem;
  suggestedId?: string | null;
  pending: boolean;
  onAttach: (item: RadarItem, cluster: CuratedStory) => void;
}) {
  const [open, setOpen] = useState(false);
  const targetsQuery = useQuery<{ stories?: CuratedStory[] }>({
    queryKey: ['/api/curated/attach-targets'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/curated/top-stories?hours=24&limit=100');
      return res.json();
    },
    enabled: open,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const clusters = useMemo(
    () => (targetsQuery.data?.stories ?? []).filter((story) => story.clusterId && story.sourceCount >= 2),
    [targetsQuery.data],
  );
  const ordered = useMemo(() => {
    if (!suggestedId) return clusters;
    const s = clusters.find((c) => c.id === suggestedId);
    return s ? [s, ...clusters.filter((c) => c.id !== suggestedId)] : clusters;
  }, [clusters, suggestedId]);
  return (
    <Popover open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (nextOpen) void targetsQuery.refetch();
    }}>
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                size="icon"
                variant="outline"
                disabled={pending}
                aria-label="Attach to a story"
                data-testid={`button-attach-open-${item.id}`}
              >
                {pending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Link2 className="h-3.5 w-3.5" />
                )}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">Attach to a story</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent align="end" className="w-80 p-1">
        <p className="px-2 py-1.5 text-xs text-muted-foreground font-mono">
          Attach to an active story (does not promote):
        </p>
          {targetsQuery.isLoading || targetsQuery.isFetching ? (
            <div className="px-2 py-3 text-xs text-muted-foreground font-mono">
              <Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1.5" />
              Refreshing active stories…
            </div>
          ) : targetsQuery.isError ? (
            <div className="px-2 py-3 text-xs text-destructive font-mono">
              Could not refresh active stories. Close and try again.
            </div>
          ) : ordered.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground font-mono">
              No formed stories are available to attach to.
            </div>
          ) : <div className="max-h-64 overflow-y-auto">
          {ordered.map((c) => (
            <button
              key={c.id}
              type="button"
              className="w-full text-left px-2 py-1.5 rounded-md hover-elevate"
              onClick={() => { setOpen(false); onAttach(item, c); }}
              data-testid={`button-attach-cluster-${item.id}-${c.id}`}
            >
              <span className="text-xs leading-snug block">
                {suggestedId === c.id && (
                  <Badge variant="secondary" className="mr-1.5 text-[10px]">Suggested</Badge>
                )}
                {c.displayTitle || c.title}
              </span>
              <span className="block mt-0.5 text-[10px] text-muted-foreground font-mono">
                {c.sourceCount} sources
                {editorTopicFocus(c as unknown as RadarItem) ? ` · ${editorTopicFocus(c as unknown as RadarItem)}` : ''}
                {` · ${timeAgo(c.articlePublishedAt || c.scrapedAt)}`}
              </span>
            </button>
          ))}
          </div>}
      </PopoverContent>
    </Popover>
  );
}

// Shared radar fetch used by the "Not surfacing (Radar)" and "Attach
// candidates" editor view modes. Same queryKey so the cache is shared, and the
// endpoint is only hit while one of those views is actually selected — a
// viewer, or an editor sitting on the normal feed, never triggers it.
function useRadarQuery(active: boolean) {
  return useQuery<RadarPayload>({
    queryKey: ['/api/curated/scoring-radar'],
    enabled: active,
    refetchInterval: active ? 30_000 : false,
    staleTime: 15_000,
    // Bounded retry — the endpoint is a heavy aggregate that can intermittently
    // 500/time out; two quick retries self-heal most blips without the editor
    // doing anything (the 30s poll then keeps retrying on its own).
    retry: 2,
    retryDelay: (attempt) => Math.min(2_000 * (attempt + 1), 5_000),
  });
}

// ---------------------------------------------------------------------------
// Editor-view sort control (Task #1135) — a compact client-side sort shared by
// the "Attach candidates" and "Scored too low (Radar)" views (and "Hidden
// stories", where its data allows). Purely client-side, applied AFTER the
// existing filters (CPC toggle etc.). The choice persists across view switches
// within the session via a module-level variable (components unmount on view
// switch, so plain component state would reset).
// ---------------------------------------------------------------------------
type EditorSortKey = 'recommended' | 'newest' | 'oldest' | 'score' | 'topic' | 'source';
let editorSortSessionPref: EditorSortKey = 'recommended';
function useEditorSort(): [EditorSortKey, (k: EditorSortKey) => void] {
  const [key, setKey] = useState<EditorSortKey>(editorSortSessionPref);
  return [key, (k: EditorSortKey) => { editorSortSessionPref = k; setKey(k); }];
}

const EDITOR_SORT_LABELS: Record<EditorSortKey, string> = {
  recommended: 'Recommended',
  newest:      'Newest',
  oldest:      'Oldest',
  score:       'Highest score',
  topic:       'Topic (A–Z)',
  source:      'Source',
};

function EditorSortSelect({
  value,
  onChange,
  options,
  testId,
}: {
  value: EditorSortKey;
  onChange: (k: EditorSortKey) => void;
  options: EditorSortKey[];
  testId: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as EditorSortKey)}>
      <SelectTrigger
        className="h-7 w-auto gap-1 px-2 text-xs font-mono border-border"
        data-testid={testId}
      >
        <span className="text-muted-foreground/60">Sort:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((k) => (
          <SelectItem key={k} value={k} className="text-xs font-mono" data-testid={`${testId}-option-${k}`}>
            {EDITOR_SORT_LABELS[k]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Sort radar items client-side. 'recommended' returns the input order (each
// view's existing default: reason-first for attach candidates, server order
// for the radar list). Missing topic values sort last; ties keep input order
// (Array.prototype.sort is stable).
function sortRadarItems(items: RadarItem[], key: EditorSortKey): RadarItem[] {
  if (key === 'recommended') return items;
  const out = items.slice();
  out.sort((a, b) => {
    switch (key) {
      case 'newest': return a.itemAgeHours - b.itemAgeHours;
      case 'oldest': return b.itemAgeHours - a.itemAgeHours;
      case 'score':  return b.decayedScore - a.decayedScore;
      case 'topic': {
        const at = a.primaryTopic ?? '';
        const bt = b.primaryTopic ?? '';
        if (!at && !bt) return 0;
        if (!at) return 1;
        if (!bt) return -1;
        return at.localeCompare(bt);
      }
      case 'source': return (a.source || '').localeCompare(b.source || '');
      default: return 0;
    }
  });
  return out;
}

// Quiet stale-data note shown when a BACKGROUND refresh fails while cached
// data is still rendering underneath — the scary red banner is reserved for
// "no data at all". The 30s poll (plus bounded retry) keeps retrying.
function RadarStaleNote({ isError, dataUpdatedAt }: { isError: boolean; dataUpdatedAt: number }) {
  if (!isError) return null;
  const mins = Math.max(1, Math.round((Date.now() - dataUpdatedAt) / 60_000));
  return (
    <div
      className="px-3 py-1.5 text-xs text-muted-foreground/70 font-mono border-b border-border"
      data-testid="text-radar-stale-note"
    >
      Refresh failed — showing data from {mins} min ago · retrying…
    </div>
  );
}

// "Scored too low (Radar)" editor view — contributing-source news items the
// AI scored below the Top Stories cut (or that failed enrichment), each with
// a Promote (P-pin) action AND an Attach action that links the item into a
// formed story WITHOUT touching its score. Deliberately EXCLUDES: items past
// the 12h editor window (decay noise), items whose RAW score clears the cut
// (they fell out from decay, not an AI miss), manually-pinned items (the
// editor already made a call), and attach-only / opinion / video rows (those
// live in the "Attach candidates" view — the two views are now disjoint).
function RadarViewBody({ active, clusters }: { active: boolean; clusters: CuratedStory[] }) {
  const { toast } = useToast();
  const [pinning, setPinning] = useState<string | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const radarQuery = useRadarQuery(active);
  const attach = useAttachToClusterMutation(setLinking);
  const [sortKey, setSortKey] = useEditorSort();

  const promote = useMutation({
    mutationFn: async (item: RadarItem) => {
      // Pin the item 10 pts above the current cut line so it clears the
      // threshold on the next clustering pass. Floor at 60 to be meaningful.
      const payload = radarQuery.data;
      const target = Math.max(60, (payload?.cutLineScore ?? 50) + 10);
      const body = {
        scope: 'standalone',
        type: item.type,
        id: item.id,
        priorityScore: Math.min(target, 100),
        // Scoring Radar telemetry.
        fromRadar: true,
        surfacingState: item.surfacingState,
        rawScore: item.priorityScore,
        decayedScore: item.decayedScore,
        itemAgeHours: item.itemAgeHours,
      };
      const res = await apiRequest('POST', '/api/curated/priority-override', body);
      return res.json();
    },
    onMutate: (item) => setPinning(item.id),
    onSettled: () => setPinning(null),
    onSuccess: (_data, item) => {
      queryClient.invalidateQueries({ queryKey: ['/api/curated/top-stories'] });
      queryClient.invalidateQueries({ queryKey: ['/api/curated/scoring-radar'] });
      toast({
        title: 'Score pinned',
        description: item.surfacingState === 'not-enriched'
          ? 'Enrichment rescue started — watch this row for its result.'
          : 'Item promoted — will surface on next cluster pass.',
      });
    },
    onError: () => {
      toast({ title: 'Failed to promote', variant: 'destructive' });
    },
  });

  const allItems = radarQuery.data?.items ?? [];
  const windowHours = radarQuery.data?.windowHours ?? 24;
  const cutLine = radarQuery.data?.cutLineScore ?? 0;
  const maxAgeH = Math.min(EDITOR_VIEW_MAX_AGE_HOURS, windowHours);
  // This view answers ONE question: which CONTRIBUTING-source news items did
  // the AI score too low (or fail to enrich)? Everything else is filtered:
  //  - older than 12h            → decay noise, not a live scoring call
  //  - raw score clears the cut  → fell out from time-decay, not an AI miss
  //  - manually pinned           → editor already made a call
  //  - attach-only/opinion/video → live in the "Attach candidates" view
  const recentActionable = allItems.filter(
    (i) => i.itemAgeHours <= maxAgeH && RADAR_STATE_ACTIONABLE.has(i.surfacingState),
  );
  const visibleItems = recentActionable.filter(
    (i) =>
      !i.hasManualOverride &&
      !(i.surfacingState === 'below-cut' && i.priorityScore >= cutLine),
  );
  const excludedPinned = recentActionable.filter((i) => !!i.hasManualOverride).length;
  const excludedDecay = recentActionable.filter(
    (i) => !i.hasManualOverride && i.surfacingState === 'below-cut' && i.priorityScore >= cutLine,
  ).length;

  // Token sets for the per-row attach suggestion (suggested cluster is listed
  // first inside the picker; any active story remains selectable).
  const clusterTokens = useMemo(
    () => clusters.map((c) => ({ c, tokens: linkTitleTokens(c.displayTitle || c.title) })),
    [clusters],
  );

  return (
    <div data-testid="view-scoring-radar">
      {radarQuery.isLoading && (
        <div className="px-3 py-4 text-xs text-muted-foreground font-mono text-center">
          <Loader2 className="h-4 w-4 animate-spin inline mr-1" />
          Loading radar…
        </div>
      )}
      {radarQuery.isError && !radarQuery.data && (
        <div className="px-3 py-3 text-xs text-destructive font-mono" data-testid="text-radar-error">
          <AlertTriangle className="h-3.5 w-3.5 inline mr-1" />
          Failed to load scoring radar.
        </div>
      )}
      {radarQuery.data && (
        <RadarStaleNote isError={radarQuery.isError} dataUpdatedAt={radarQuery.dataUpdatedAt} />
      )}
      {radarQuery.data && visibleItems.length === 0 && (
        <div className="px-3 py-4 text-xs text-muted-foreground font-mono text-center">
          No recent items were scored too low — the AI and the feed agree right now.
          {(excludedPinned > 0 || excludedDecay > 0) && (
            <span className="block mt-1 text-muted-foreground/50" data-testid="text-radar-excluded">
              Excluded: {excludedDecay > 0 ? `${excludedDecay} decay-aged` : ''}
              {excludedDecay > 0 && excludedPinned > 0 ? ' · ' : ''}
              {excludedPinned > 0 ? `${excludedPinned} manually pinned` : ''}
            </span>
          )}
        </div>
      )}
      {radarQuery.data && visibleItems.length > 0 && (
        <>
          <div className="px-3 py-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground/60 font-mono border-b border-border">
            <span>Cut line: {radarQuery.data.cutLineScore}</span>
            <span>Surfacing: {radarQuery.data.surfacingCount}</span>
            <span>Showing last {maxAgeH}h</span>
            <span>{visibleItems.length} scored too low</span>
            <span className="ml-auto">
              <EditorSortSelect
                value={sortKey}
                onChange={setSortKey}
                options={['recommended', 'newest', 'oldest', 'score', 'topic', 'source']}
                testId="select-radar-sort"
              />
            </span>
            {(excludedPinned > 0 || excludedDecay > 0) && (
              <span data-testid="text-radar-excluded">
                excluded: {excludedDecay > 0 ? `${excludedDecay} decay-aged` : ''}
                {excludedDecay > 0 && excludedPinned > 0 ? ' · ' : ''}
                {excludedPinned > 0 ? `${excludedPinned} pinned` : ''}
              </span>
            )}
          </div>
          <div className="divide-y divide-border" data-testid="list-radar-items">
            {sortRadarItems(visibleItems, sortKey).map((item) => {
              const topicFocus = editorTopicFocus(item);
              const suggested = bestClusterMatch(item, clusterTokens);
              return (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-2 px-3 py-2"
                  data-testid={`row-radar-item-${item.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <EditorItemTitle url={item.url} title={item.title} testId={`text-radar-title-${item.id}`} />
                    <p className="text-xs text-muted-foreground font-mono truncate mt-0.5 flex items-center gap-2">
                      <span>{item.source}</span>
                      <span className="text-muted-foreground/50">·</span>
                      <span>AI {item.priorityScore} → decayed {item.decayedScore}</span>
                      <span className="text-muted-foreground/50">·</span>
                      <span>{Math.max(0, item.itemAgeHours).toFixed(1)}h old</span>
                      {topicFocus && (
                        <>
                          <span className="text-muted-foreground/50">·</span>
                          <span data-testid={`text-radar-topicfocus-${item.id}`}>{topicFocus}</span>
                        </>
                      )}
                      {item.surfacingState === 'not-enriched' && (
                        <>
                          <span className="text-muted-foreground/50">·</span>
                          <span data-testid={`text-radar-rescue-${item.id}`}>
                            {item.rescueStatus === 'pending' ? (
                              <>
                                <Loader2 className="h-3 w-3 animate-spin inline mr-0.5" />
                                Rescue running…
                              </>
                            ) : item.rescueStatus === 'failed' ? (
                              <span className="text-destructive">
                                Rescue failed{(item.enrichmentAttempts ?? 0) > 0 ? ` · ${item.enrichmentAttempts} attempt${(item.enrichmentAttempts ?? 0) === 1 ? '' : 's'}` : ''}
                              </span>
                            ) : item.rescueStatus === 'succeeded' ? (
                              'Rescue done — refreshing'
                            ) : item.enrichmentLifecycle === 'retry-capped' ? (
                              <span className="text-destructive">
                                Retry cap reached · {item.enrichmentAttempts ?? 0} attempts
                              </span>
                            ) : item.enrichmentLifecycle === 'backed-off' ? (
                              `Retrying after backoff · ${item.enrichmentAttempts ?? 0} attempt${(item.enrichmentAttempts ?? 0) === 1 ? '' : 's'}`
                            ) : (item.enrichmentAttempts ?? 0) > 0 ? (
                              `${item.enrichmentAttempts} failed enrichment attempt${(item.enrichmentAttempts ?? 0) === 1 ? '' : 's'}`
                            ) : (
                              'no enrichment attempt yet'
                            )}
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {item.possibleExplainer && (
                      <Badge
                        variant="outline"
                        className="text-xs font-mono border-amber-500/50 text-amber-600 dark:text-amber-400"
                        data-testid={`badge-possible-explainer-${item.id}`}
                        title="Title has an interrogative pattern (trailing ? or WH-lead) but no URL/page content-kind signal — review whether this is analysis/opinion."
                      >
                        Possible explainer?
                      </Badge>
                    )}
                    {item.surfacingState === 'not-enriched' && (
                      <Badge
                        variant="secondary"
                        className="text-xs font-mono"
                        data-testid={`badge-radar-state-${item.id}`}
                      >
                        {RADAR_STATE_LABELS['not-enriched']}
                      </Badge>
                    )}
                    <AttachClusterPicker
                      item={item}
                      suggestedId={suggested?.id ?? null}
                      pending={linking === item.id}
                      onAttach={(i, c) => attach.mutate({ item: i, cluster: c })}
                    />
                    <TooltipProvider delayDuration={150}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon"
                            variant="outline"
                            disabled={pinning === item.id || promote.isPending}
                            onClick={() => promote.mutate(item)}
                            aria-label="Promote to Top Stories"
                            data-testid={`button-promote-radar-${item.id}`}
                          >
                            {pinning === item.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Plus className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top">Promote to Top Stories</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// Attach-candidate matching — pure client-side title-token overlap between
// attach-only radar items and currently FORMED clusters (tens × tens, trivial
// compute, zero AI, zero new endpoints). Tokens are lowercased words ≥4 chars
// minus a small stopword list; a suggestion needs ≥2 shared tokens.
const LINK_STOP_TOKENS = new Set([
  'this', 'that', 'with', 'from', 'after', 'over', 'amid', 'into', 'their',
  'says', 'said', 'will', 'have', 'been', 'more', 'than', 'about', 'against',
  'could', 'would', 'should', 'were', 'when', 'what', 'they', 'them', 'there',
  'report', 'reports', 'news', 'breaking', 'live', 'update', 'updates',
]);
function linkTitleTokens(title: string): Set<string> {
  return new Set(
    (title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !LINK_STOP_TOKENS.has(w)),
  );
}

// "Attach candidates" editor view — ALL recent attach-eligible items from the
// radar payload: attach-only rows (CPC contrast lane + non-CPC attach tier)
// plus contributing-source opinion/analysis/video pieces. Each row's Attach
// button opens a cluster picker (token-match suggestion first, any active
// story selectable) that writes the existing manual-link overlay via
// POST /api/curated/link-items (must-link clustering + audit + telemetry all
// already ride that endpoint) — attach-only items can never seed or represent
// a story, so this only ever ADDS coverage breadth to an already-formed one.
// Reason order for sorting attach candidates: most-actionable first.
const ATTACH_REASON_ORDER: Record<string, number> = {
  'would-auto-attach': 0,
  'ambiguous':         1,
  'no-match':          2,
  'manual-only':       3,
};

// Compact tooltip label for each bridge recommendation reason.
function AttachReasonIndicator({
  item,
  clusters,
}: {
  item: RadarItem;
  clusters: CuratedStory[];
}) {
  const rec = item.attachRecommendation;
  if (!rec) return null;

  let dotClass: string;
  let tipText: string;

  if (rec.reason === 'would-auto-attach') {
    const story = clusters.find((c) => c.id === rec.matchedClusterId);
    const title = story ? (story.displayTitle || story.title) : 'a formed story';
    dotClass = 'text-emerald-500 dark:text-emerald-400';
    tipText = `Will auto-attach to: ${title}`;
  } else if (rec.reason === 'ambiguous') {
    dotClass = 'text-amber-500 dark:text-amber-400';
    tipText = `Ambiguous — matches ${rec.matchCount} active stories; needs a manual call`;
  } else if (rec.reason === 'no-match') {
    dotClass = 'text-muted-foreground/40';
    tipText = 'No confident match — waiting for next clustering pass';
  } else {
    dotClass = 'text-muted-foreground/30';
    tipText = 'Manual only — lane the bridge does not auto-attach';
  }

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex items-center shrink-0 cursor-default ${dotClass}`}
            aria-label={tipText}
            data-testid={`indicator-attach-reason-${item.id}`}
          >
            <Circle className="h-2 w-2 fill-current" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64 text-xs">
          {tipText}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function LinkCandidatesViewBody({ active, clusters }: { active: boolean; clusters: CuratedStory[] }) {
  const [linking, setLinking] = useState<string | null>(null);
  // CPC / non-CPC separation — filters the WHOLE list (every row here is
  // attach-eligible by construction, so the toggle always has effect).
  const [cpcFilter, setCpcFilter] = useState<'all' | 'cpc' | 'non-cpc'>('all');
  const [sortKey, setSortKey] = useEditorSort();
  const radarQuery = useRadarQuery(active);
  const attach = useAttachToClusterMutation(setLinking);
  const maxAgeH = Math.min(EDITOR_VIEW_MAX_AGE_HOURS, radarQuery.data?.windowHours ?? EDITOR_VIEW_MAX_AGE_HOURS);

  const candidates = useMemo(() => {
    if (!active) return [];
    // EVERY recent attach-eligible item is listed — attach-only rows (CPC
    // contrast lane + non-CPC attach tier) AND contributing-source opinion /
    // analysis / video items, which are held out of standalone Top Stories
    // exactly like attach-only rows and can only ride along inside a story.
    const items = (radarQuery.data?.items ?? []).filter(
      (i) =>
        (i.surfacingState === 'attach-only' || i.surfacingState === 'opinion-video') &&
        !!i.url &&
        i.itemAgeHours <= maxAgeH,
    );
    // Sort by bridge recommendation reason first (would-auto-attach most
    // actionable), then by score within each reason group.
    const out = items.slice();
    out.sort((a, b) => {
      const ar = ATTACH_REASON_ORDER[a.attachRecommendation?.reason ?? ''] ?? 4;
      const br = ATTACH_REASON_ORDER[b.attachRecommendation?.reason ?? ''] ?? 4;
      if (ar !== br) return ar - br;
      return b.decayedScore - a.decayedScore;
    });
    return out;
  }, [active, radarQuery.data, maxAgeH]);

  const cpcCount = candidates.filter((item) => !!item.isCpc).length;
  const visibleCandidates = candidates.filter((item) => {
    if (cpcFilter === 'all') return true;
    return cpcFilter === 'cpc' ? !!item.isCpc : !item.isCpc;
  });

  return (
    <div data-testid="view-link-candidates">
      {radarQuery.isLoading && (
        <div className="px-3 py-4 text-xs text-muted-foreground font-mono text-center">
          <Loader2 className="h-4 w-4 animate-spin inline mr-1" />
          Finding attach candidates…
        </div>
      )}
      {radarQuery.isError && !radarQuery.data && (
        <div className="px-3 py-3 text-xs text-destructive font-mono" data-testid="text-link-candidates-error">
          <AlertTriangle className="h-3.5 w-3.5 inline mr-1" />
          Failed to load attach candidates.
        </div>
      )}
      {radarQuery.data && (
        <RadarStaleNote isError={radarQuery.isError} dataUpdatedAt={radarQuery.dataUpdatedAt} />
      )}
      {radarQuery.data && candidates.length === 0 && (
        <div className="px-3 py-4 text-xs text-muted-foreground font-mono text-center">
          No attach-eligible items in the last {maxAgeH}h.
        </div>
      )}
      {candidates.length > 0 && (
        <>
          <div className="px-3 py-1.5 flex flex-wrap items-center gap-2 text-xs font-mono border-b border-border">
            <span className="text-muted-foreground/60">Show:</span>
            <Button
              size="sm"
              variant="ghost"
              className={`font-mono text-xs toggle-elevate ${cpcFilter === 'all' ? 'toggle-elevated' : 'text-muted-foreground'}`}
              onClick={() => setCpcFilter('all')}
              data-testid="button-link-candidates-all"
            >
              All ({candidates.length})
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className={`font-mono text-xs toggle-elevate ${cpcFilter === 'cpc' ? 'toggle-elevated' : 'text-muted-foreground'}`}
              onClick={() => setCpcFilter('cpc')}
              data-testid="button-link-candidates-cpc"
            >
              CPC ({cpcCount})
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className={`font-mono text-xs toggle-elevate ${cpcFilter === 'non-cpc' ? 'toggle-elevated' : 'text-muted-foreground'}`}
              onClick={() => setCpcFilter('non-cpc')}
              data-testid="button-link-candidates-noncpc"
            >
              Non-CPC ({candidates.length - cpcCount})
            </Button>
            <span className="ml-auto flex items-center gap-2">
              <EditorSortSelect
                value={sortKey}
                onChange={setSortKey}
                options={['recommended', 'newest', 'oldest', 'score', 'topic', 'source']}
                testId="select-link-candidates-sort"
              />
              <span className="text-muted-foreground/60">Last {maxAgeH}h</span>
            </span>
          </div>
          {visibleCandidates.length === 0 && (
            <div className="px-3 py-4 text-xs text-muted-foreground font-mono text-center">
              No {cpcFilter === 'cpc' ? 'CPC' : 'non-CPC'} attach candidates right now.
            </div>
          )}
        <div className="divide-y divide-border" data-testid="list-link-candidates">
          {sortRadarItems(visibleCandidates, sortKey).map((item) => {
            const topicFocus = editorTopicFocus(item);
            // Reconcile URL-shape + page-labeled signals the same way every
            // other surface does (audio comes back as its own kind).
            const kind = getEffectiveContentKindWithTitle(
              item.url,
              item.title,
              (item.contentKind ?? null) as StoredContentKind,
            );
            const hasKindBadge = kind === 'video' || kind === 'opinion' || kind === 'explainer' || kind === 'live' || kind === 'podcast';
            return (
              <div
                key={item.id}
                className="flex items-center justify-between gap-2 px-3 py-2"
                data-testid={`row-link-candidate-${item.id}`}
              >
                <div className="min-w-0 flex-1">
                  <EditorItemTitle url={item.url} title={item.title} testId={`text-link-candidate-title-${item.id}`} />
                  <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">
                    {item.source}
                    <span className="text-muted-foreground/50"> · </span>
                    <span data-testid={`text-link-candidate-age-${item.id}`}>{Math.max(0, item.itemAgeHours).toFixed(1)}h old</span>
                    {topicFocus && (
                      <>
                        <span className="text-muted-foreground/50"> · </span>
                        <span data-testid={`text-link-candidate-topicfocus-${item.id}`}>{topicFocus}</span>
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {item.isCpc && (
                    <Badge variant="outline" className="text-xs font-mono" data-testid={`badge-link-candidate-cpc-${item.id}`}>
                      CPC
                    </Badge>
                  )}
                  {hasKindBadge ? (
                    <ContentKindBadge kind={kind} />
                  ) : item.surfacingState === 'opinion-video' ? (
                    // Single-source opinion/analysis piece with no specific
                    // content-kind detected — still distinguishable at a glance.
                    <Badge variant="secondary" className="text-xs font-mono" data-testid={`badge-link-candidate-nonnews-${item.id}`}>
                      {kind === 'audio' ? 'Audio' : 'Opinion/Analysis'}
                    </Badge>
                  ) : null}
                  <AttachReasonIndicator item={item} clusters={clusters} />
                  <AttachClusterPicker
                    item={item}
                    suggestedId={item.attachRecommendation?.matchedClusterId ?? null}
                    pending={linking === item.id}
                    onAttach={(i, c) => attach.mutate({ item: i, cluster: c })}
                  />
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}
    </div>
  );
}

// "Hidden stories" editor view — replaces the ranked Top Stories list body
// with the editor-hidden stories and an Un-hide action. The list data already
// rides the top-stories payload (hiddenStories), so this view needs no fetch.
function HiddenViewBody({ items }: { items: HiddenStorySummary[] }) {
  const { toast } = useToast();
  // Shared editor sort — hidden rows carry no score/topic, so those options
  // aren't offered here; an unsupported carried-over choice falls back to the
  // default (server) order.
  const [sortKey, setSortKey] = useEditorSort();
  const hiddenTime = (i: HiddenStorySummary) =>
    new Date(i.articlePublishedAt ?? i.scrapedAt).getTime() || 0;
  const sortedItems = (() => {
    if (sortKey === 'newest' || sortKey === 'oldest' || sortKey === 'source') {
      const out = items.slice();
      out.sort((a, b) => {
        if (sortKey === 'source') return (a.source || '').localeCompare(b.source || '');
        return sortKey === 'newest' ? hiddenTime(b) - hiddenTime(a) : hiddenTime(a) - hiddenTime(b);
      });
      return out;
    }
    return items;
  })();
  const unhide = useMutation({
    mutationFn: async (item: HiddenStorySummary) => {
      // Prefer the stored hidden-row key(s) carried in the payload so a story
      // whose cluster identity churned after a re-cluster still un-hides the
      // ORIGINAL row(s). Fall back to the reconstructed scope/key for older
      // payloads that predate hiddenRecordKeys. `fromRadar` marks this as an
      // editor-view-prompted correction for the learning loop.
      const isCluster = item.sourceCount > 1 && !!item.clusterId;
      const body =
        item.hiddenRecordKeys && item.hiddenRecordKeys.length > 0
          ? { hidden: false, recordKeys: item.hiddenRecordKeys, fromRadar: true }
          : isCluster
            ? { scope: "cluster", clusterId: item.clusterId, hidden: false, fromRadar: true }
            : { scope: "standalone", type: item.type, id: item.id, hidden: false, fromRadar: true };
      const res = await apiRequest("POST", "/api/curated/hide-story", body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/curated/top-stories"] });
      toast({ title: "Story restored", description: "Back in the Curated view." });
    },
    onError: () => {
      toast({ title: "Failed to restore story", variant: "destructive" });
    },
  });

  if (items.length === 0) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground font-mono text-center" data-testid="view-hidden-empty">
        No hidden stories.
      </div>
    );
  }

  return (
    <div data-testid="view-hidden-stories">
      <div className="px-3 py-1.5 flex items-center justify-end border-b border-border">
        <EditorSortSelect
          value={sortKey}
          onChange={setSortKey}
          options={['recommended', 'newest', 'oldest', 'source']}
          testId="select-hidden-sort"
        />
      </div>
    <div className="divide-y divide-border" data-testid="list-hidden-stories">
      {sortedItems.map((item) => (
        <div
          key={item.id}
          className="flex items-center justify-between gap-2 px-3 py-2"
          data-testid={`row-hidden-story-${item.id}`}
        >
          <div className="min-w-0">
            <EditorItemTitle url={item.url} title={item.title} testId={`text-hidden-title-${item.id}`} />
            <p className="text-xs text-muted-foreground font-mono truncate">
              {item.source}
              {item.sourceCount > 1 ? ` · ${item.sourceCount} sources` : ""}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => unhide.mutate(item)}
            disabled={unhide.isPending}
            data-testid={`button-unhide-story-${item.id}`}
          >
            <Eye className="h-3.5 w-3.5 mr-1.5" />
            Un-hide
          </Button>
        </div>
      ))}
    </div>
    </div>
  );
}

/**
 * Small (i) info icon shown next to a story-detail section header. Tapping /
 * clicking it reveals a concise plain-language explainer ending with a "See
 * more in methodology" link that opens the methodology guide scrolled to the
 * matching section. `onNavigate` stashes the open story before the route
 * change so it re-opens on return.
 *
 * This is a Popover (click-toggled), NOT a Tooltip: Radix tooltips also open
 * on FOCUS, and the story-detail Dialog auto-focuses its first focusable
 * element on open — which made this explainer pop open automatically every
 * time a story was opened on mobile, blocking taps (touch has no hover-out to
 * dismiss it). A Popover only opens on an actual click/tap and closes on any
 * outside tap or Esc, on both desktop and mobile.
 */
function MethodologyInfoIcon({
  section,
  onNavigate,
  testId,
  children,
}: {
  section: string;
  onNavigate: (section: string) => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center cursor-pointer align-middle"
          aria-label="What does this mean?"
          data-testid={testId}
        >
          <Info className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="max-w-xs w-auto p-3 text-xs leading-relaxed bg-popover/90 backdrop-blur-md border-border shadow-lg"
        style={
          { "--popover": "0 0% 20%", "--popover-foreground": "0 0% 98%" } as React.CSSProperties
        }
      >
        <div className="normal-case font-normal tracking-normal text-popover-foreground">
          {children}
        </div>
        <button
          type="button"
          onClick={() => onNavigate(section)}
          className="mt-2 inline-flex text-curated-accent-strong hover:underline normal-case font-medium tracking-normal"
          data-testid={`${testId}-link`}
        >
          See more in methodology
        </button>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Body for a SectionHeading hover tooltip: a plain-language explainer followed
 * by a "See more in methodology" deep-link (matching the story-popup info
 * icons). Used on the Custom Feed, Top Stories, and State Controlled Narratives
 * section headers. Reads navigation off wouter directly so it works inside the
 * rotating column's per-pane tooltip without threading a handler through.
 */
function SectionMethodologyTooltip({
  section,
  testId,
  children,
}: {
  section: string;
  testId: string;
  children: React.ReactNode;
}) {
  const [, navigate] = useLocation();
  return (
    <>
      <div>{children}</div>
      <button
        type="button"
        onClick={() => navigate(`/curated/methodology?section=${section}`)}
        className="mt-2 inline-flex text-curated-accent-strong hover:underline font-medium"
        data-testid={`${testId}-link`}
      >
        See more in methodology
      </button>
    </>
  );
}

// Allowlist-gated SINGLE-SOURCE photo replace (Task #380 expansion). A small,
// inconspicuous control in the detail hero overlay. Accepts EITHER a typed/pasted
// image URL (server SSRF-validates) OR a pasted clipboard image (uploaded to OUR
// object storage — no SSRF surface). The new photo becomes a curated-only display
// override keyed by the item; curated_items.url/ogImageUrl are never mutated.
// Curated-lane only — never the main feed or public API.

// Unified editor pencil control (Task #904) — merges CuratedClassificationEditor
// and EditHeadlineControl into a single pencil icon that opens a two-tab popover:
// "Labels" (Topic / Focus / Region / Country classification) and "Headline"
// (headline + bullets override with Manual / AI assist sub-tabs). Both save paths
// and all existing mutations are preserved exactly; only the trigger is merged.
function CuratedEditControl({ story }: { story: CuratedStory }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [mainTab, setMainTab] = useState<"labels" | "headline">("labels");

  // ── Labels state ──────────────────────────────────────────────────────────
  const NONE = "__none__";
  const [topic, setTopic] = useState<string>("");
  const [track, setTrack] = useState<string>(NONE);
  const [region, setRegion] = useState<string>("");
  const [country, setCountry] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    setTopic(story.primaryTopic ?? "");
    setTrack(story.conflictTrack ?? NONE);
    setRegion(story.region ?? "");
    setCountry(story.country ?? "");
  }, [open, story]);

  const classificationMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/curated/classification", {
        url: story.url,
        primaryTopic: topic,
        conflictTrack: track === NONE ? "" : track,
        region: region.trim(),
        country: country.trim(),
      });
      return res.json();
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/curated/top-stories"] });
      const prev = queryClient.getQueryData(["/api/curated/top-stories", { hours: 24, limit: 100 }]);
      queryClient.setQueriesData<{ stories?: CuratedStory[] } & Record<string, unknown>>(
        { queryKey: ["/api/curated/top-stories"] },
        (old) => {
          if (!old?.stories) return old;
          return {
            ...old,
            stories: old.stories.map((s: CuratedStory) => {
              if (s.url !== story.url) return s;
              return {
                ...s,
                primaryTopic: topic || s.primaryTopic,
                conflictTrack: track === NONE ? null : track,
                region: region.trim() || s.region,
                country: country.trim() || s.country,
              };
            }),
          };
        },
      );
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev !== undefined) {
        queryClient.setQueryData(["/api/curated/top-stories", { hours: 24, limit: 100 }], context.prev);
      }
      toast({ title: "Failed to save correction", description: "Check the topic/focus and try again.", variant: "destructive" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/curated/top-stories"] });
      queryClient.invalidateQueries({ queryKey: ["/api/curated/cluster-members"] });
      toast({ title: "Classification updated", description: "Saved as a protected correction." });
      setOpen(false);
    },
  });

  const handleSaveLabels = () => {
    if (!topic) {
      toast({ title: "Pick a Topic", variant: "destructive" });
      return;
    }
    classificationMutation.mutate();
  };

  // ── Headline state ─────────────────────────────────────────────────────────
  const [headlineTab, setHeadlineTab] = useState<"manual" | "ai">("manual");
  const [headline, setHeadline] = useState("");
  const [bulletsText, setBulletsText] = useState("");
  const [claimsText, setClaimsText] = useState("");
  const [aiText, setAiText] = useState("");
  const [busy, setBusy] = useState(false);
  const hasOverride = !!story.headlineOverride;
  const isAutoOverride = story.headlineOverride?.provenance === "auto";

  const fillFromStory = () => {
    setHeadline(story.headlineOverride?.headline ?? story.headline ?? story.displayTitle ?? story.title ?? "");
    const bullets = story.headlineOverride?.bullets
      ?? story.facts
      ?? story.summaryBullets
      ?? (story.summary ? [story.summary] : []);
    setBulletsText(bullets.join("\n"));
    setClaimsText((story.headlineOverride?.claims ?? story.attributedClaims ?? []).join("\n"));
  };

  const handleOpen = (o: boolean) => {
    if (o) {
      setMainTab("labels");
      setHeadlineTab("manual");
      fillFromStory();
      setAiText("");
    }
    setOpen(o);
  };

  const headlineStoryKey = story.clusterId
    ? { scope: "cluster" as const, clusterId: story.clusterId }
    : { scope: "standalone" as const, type: story.type, id: story.id };

  const invalidateHeadline = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/curated/top-stories"] });
    queryClient.invalidateQueries({ queryKey: ["/api/curated/cluster-members"] });
  };

  const optimisticHeadlineUpdate = (patch: Partial<Pick<CuratedStory, "headlineOverride">>): unknown => {
    const prev = queryClient.getQueryData(["/api/curated/top-stories", { hours: 24, limit: 100 }]);
    queryClient.setQueriesData<{ stories?: CuratedStory[] } & Record<string, unknown>>(
      { queryKey: ["/api/curated/top-stories"] },
      (old) => {
        if (!old?.stories) return old;
        return {
          ...old,
          stories: old.stories.map((s: CuratedStory) => {
            const matches = story.clusterId
              ? s.clusterId === story.clusterId
              : s.type === story.type && s.id === story.id;
            return matches ? { ...s, ...patch } : s;
          }),
        };
      },
    );
    return prev;
  };

  const saveHeadline = async () => {
    const h = headline.trim() || null;
    const bs = bulletsText.split("\n").map((l) => l.trim()).filter(Boolean);
    const b = bs.length > 0 ? bs : null;
    const cs = claimsText.split("\n").map((l) => l.trim()).filter(Boolean);
    const c = cs.length > 0 ? cs : null;
    if (!h && !b && !c) {
      toast({ title: "Enter a headline, bullets, and/or attributed claims", variant: "destructive" });
      return;
    }
    setBusy(true);
    const prev = optimisticHeadlineUpdate({ headlineOverride: { headline: h, bullets: b, claims: c, provenance: "human" } });
    try {
      await apiRequest("POST", "/api/curated/replace-headline", { ...headlineStoryKey, headline: h, bullets: b, claims: c });
      invalidateHeadline();
      toast({ title: "Curated correction saved", description: "Headline, bullets, and claims are Curated-only." });
      setOpen(false);
    } catch {
      queryClient.setQueryData(["/api/curated/top-stories", { hours: 24, limit: 100 }], prev);
      toast({ title: "Failed to save", description: "Try again.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const clearHeadline = async () => {
    setBusy(true);
    const prev = optimisticHeadlineUpdate({ headlineOverride: null });
    try {
      await apiRequest("POST", "/api/curated/replace-headline", { ...headlineStoryKey, clear: true });
      invalidateHeadline();
      toast({ title: "Override cleared", description: "Reverted to original." });
      setOpen(false);
    } catch {
      queryClient.setQueryData(["/api/curated/top-stories", { hours: 24, limit: 100 }], prev);
      toast({ title: "Failed to clear override", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const aiAssist = async () => {
    const t = aiText.trim();
    if (t.length < 50) {
      toast({ title: "Paste more text (at least 50 chars)", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await apiRequest("POST", "/api/curated/parse-headline", {
        text: t,
        currentHeadline: story.headline ?? story.displayTitle ?? story.title,
      });
      const data = await res.json();
      if (data.headline) setHeadline(data.headline);
      if (Array.isArray(data.bullets) && data.bullets.length > 0) setBulletsText(data.bullets.join("\n"));
      setHeadlineTab("manual");
    } catch {
      toast({ title: "AI assist failed", description: "Edit manually instead.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const hasLabelOverride = !!(story.primaryTopic || story.conflictTrack || story.region || story.country);
  const showsOverride = hasOverride || hasLabelOverride;

  return (
    <TooltipProvider>
      <Tooltip>
        <Popover open={open} onOpenChange={handleOpen}>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                onClick={(e) => e.stopPropagation()}
                className={`text-curated-accent-strong ${showsOverride ? "bg-curated-accent/20" : ""}`}
                data-testid={`button-edit-story-${story.id}`}
              >
                <Pencil className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Edit labels &amp; headline</TooltipContent>
          <PopoverContent
            className="w-80 p-3"
            align="end"
            onClick={(e) => e.stopPropagation()}
            data-testid={`popover-edit-story-${story.id}`}
          >
            {/* Main tab bar */}
            <div className="flex gap-1 mb-3 border-b border-border pb-2">
              <button
                onClick={() => setMainTab("labels")}
                className={`text-xs px-2 py-0.5 rounded-sm ${mainTab === "labels" ? "bg-curated-accent/20 text-curated-accent-strong" : "text-muted-foreground"}`}
                data-testid={`tab-edit-labels-${story.id}`}
              >
                Labels
              </button>
              <button
                onClick={() => setMainTab("headline")}
                className={`text-xs px-2 py-0.5 rounded-sm ${mainTab === "headline" ? "bg-curated-accent/20 text-curated-accent-strong" : "text-muted-foreground"}`}
                data-testid={`tab-edit-headline-${story.id}`}
              >
                Headline{hasOverride && <span className="ml-1 text-curated-accent-strong">·</span>}
              </button>
            </div>

            {mainTab === "labels" ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold">Correct labels (Curated view only)</p>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Topic</label>
                  <Select value={topic} onValueChange={setTopic}>
                    <SelectTrigger className="h-8" data-testid={`select-topic-${story.id}`}>
                      <span className="truncate">{topic || "Select topic"}</span>
                    </SelectTrigger>
                    <SelectContent>
                      {/* Alphabetical for scan-ability in the manual picker (vocab
                          PRIMARY_TOPICS order elsewhere is untouched). */}
                      {[...PRIMARY_TOPICS].sort((a, b) => a.localeCompare(b)).map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Focus (conflict track)</label>
                  <Select value={track} onValueChange={setTrack}>
                    <SelectTrigger className="h-8" data-testid={`select-track-${story.id}`}>
                      <span className="truncate">{track === NONE ? "None" : track}</span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>None</SelectItem>
                      {CONFLICT_TRACKS.map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Region</label>
                  <Input
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    placeholder="e.g. Middle East"
                    data-testid={`input-region-${story.id}`}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Country</label>
                  <Input
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    placeholder="e.g. Israel (optional)"
                    data-testid={`input-country-${story.id}`}
                  />
                </div>
                <Button
                  size="sm"
                  variant="curated"
                  className="w-full"
                  onClick={handleSaveLabels}
                  disabled={classificationMutation.isPending}
                  data-testid={`button-save-classification-${story.id}`}
                >
                  {classificationMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save correction"}
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold">
                    Edit headline &amp; bullets
                    {hasOverride && (
                      <span className="ml-1.5 text-curated-accent-strong">{isAutoOverride ? "(auto)" : "(override)"}</span>
                    )}
                  </p>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setHeadlineTab("manual")}
                      className={`text-xs px-2 py-0.5 rounded-sm ${headlineTab === "manual" ? "bg-curated-accent/20 text-curated-accent-strong" : "text-muted-foreground"}`}
                      data-testid={`tab-headline-manual-${story.id}`}
                    >
                      Manual
                    </button>
                    <button
                      onClick={() => setHeadlineTab("ai")}
                      className={`text-xs px-2 py-0.5 rounded-sm ${headlineTab === "ai" ? "bg-curated-accent/20 text-curated-accent-strong" : "text-muted-foreground"}`}
                      data-testid={`tab-headline-ai-${story.id}`}
                    >
                      AI assist
                    </button>
                  </div>
                </div>
                {headlineTab === "manual" ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Override the headline and/or bullets shown in Curated only. Leave blank to keep original.
                    </p>
                    <Input
                      placeholder="Corrected headline…"
                      value={headline}
                      onChange={(e) => setHeadline(e.target.value)}
                      data-testid={`input-edit-headline-${story.id}`}
                      className="text-sm"
                    />
                    <Textarea
                      placeholder={"Bullet 1\nBullet 2\nBullet 3"}
                      value={bulletsText}
                      onChange={(e) => setBulletsText(e.target.value)}
                      rows={4}
                      data-testid={`textarea-edit-bullets-${story.id}`}
                      className="text-xs resize-none"
                    />
                    <Textarea
                      placeholder={"Attributed claim or key statement 1\nAttributed claim or key statement 2"}
                      value={claimsText}
                      onChange={(e) => setClaimsText(e.target.value)}
                      rows={4}
                      data-testid={`textarea-edit-attributed-claims-${story.id}`}
                      className="text-xs resize-none"
                      aria-label="Attributed claims and key statements"
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="curated"
                        className="flex-1"
                        onClick={() => void saveHeadline()}
                        disabled={busy}
                        data-testid={`button-save-headline-${story.id}`}
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
                      </Button>
                      {hasOverride && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void clearHeadline()}
                          disabled={busy}
                          data-testid={`button-clear-headline-${story.id}`}
                          title="Reset to original"
                        >
                          Reset
                        </Button>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Paste the article text and let AI propose a corrected headline and bullets.
                    </p>
                    <Textarea
                      placeholder="Paste article text here (50+ chars)…"
                      value={aiText}
                      onChange={(e) => setAiText(e.target.value)}
                      rows={5}
                      data-testid={`textarea-ai-text-${story.id}`}
                      className="text-xs resize-none"
                    />
                    <Button
                      size="sm"
                      variant="curated"
                      className="w-full"
                      onClick={() => void aiAssist()}
                      disabled={busy || aiText.trim().length < 50}
                      data-testid={`button-ai-assist-${story.id}`}
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Generate from text"}
                    </Button>
                  </>
                )}
              </div>
            )}
          </PopoverContent>
        </Popover>
      </Tooltip>
    </TooltipProvider>
  );
}

function EditPhotoControl({
  type,
  id,
  clusterId,
}: {
  type: CuratedStory["type"];
  id: string;
  // When set, the override targets the whole CLUSTER (keyed `cluster:<id>` on
  // the server) instead of the standalone item — photo-upload parity for
  // multi-source stories.
  clusterId?: string | null;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const finish = (msg: string) => {
    queryClient.invalidateQueries({ queryKey: ["/api/curated/top-stories"] });
    queryClient.invalidateQueries({ queryKey: ["/api/curated/cluster-members"] });
    toast({ title: msg, description: "Curated view only." });
    setOpen(false);
    setUrl("");
  };

  const saveUrl = async () => {
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) {
      toast({ title: "Enter a full image URL (https://…)", variant: "destructive" });
      return;
    }
    setBusy(true);
    // Optimistic update — swap the displayed photo immediately so the editor
    // sees the change without waiting for the server round-trip.
    const prev = queryClient.getQueryData(["/api/curated/top-stories", { hours: 24, limit: 100 }]);
    queryClient.setQueriesData<{ stories?: CuratedStory[] } & Record<string, unknown>>(
      { queryKey: ["/api/curated/top-stories"] },
      (old) => {
        if (!old?.stories) return old;
        return {
          ...old,
          stories: old.stories.map((s: CuratedStory) =>
            (clusterId ? s.clusterId === clusterId : s.type === type && s.id === id)
              ? { ...s, ogImageUrl: u, memberImages: u ? [u, ...(s.memberImages ?? []).filter((x) => x !== s.ogImageUrl)] : s.memberImages }
              : s,
          ),
        };
      },
    );
    try {
      const res = await apiRequest("POST", "/api/curated/replace-image",
        clusterId ? { scope: "cluster", clusterId, url: u } : { type, id, url: u });
      await res.json();
      finish("Photo replaced");
    } catch {
      // Rollback optimistic update.
      queryClient.setQueryData(["/api/curated/top-stories", { hours: 24, limit: 100 }], prev);
      toast({
        title: "Failed to replace photo",
        description: "Check the URL and try again.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  // Pasted/copied image bytes go to OUR object storage (apiRequest is JSON-only,
  // so this uses a raw multipart fetch with the session cookie attached).
  const uploadBlob = async (blob: Blob) => {
    if (!blob.type.startsWith("image/")) {
      toast({ title: "Clipboard has no image", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("image", blob, "pasted-image.png");
      if (clusterId) {
        fd.append("scope", "cluster");
        fd.append("clusterId", clusterId);
      } else {
        fd.append("type", type);
        fd.append("id", id);
      }
      const res = await fetch("/api/curated/upload-image", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) throw new Error(String(res.status));
      await res.json();
      finish("Photo uploaded");
    } catch {
      toast({ title: "Failed to upload pasted image", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const item = Array.from(e.clipboardData.items).find((it) =>
      it.type.startsWith("image/"),
    );
    if (item) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (blob) void uploadBlob(blob);
    }
  };

  const pasteFromClipboard = async () => {
    try {
      const items = await (navigator.clipboard as any).read();
      for (const it of items) {
        const imgType = (it.types as string[]).find((t) => t.startsWith("image/"));
        if (imgType) {
          const blob = await it.getType(imgType);
          void uploadBlob(blob);
          return;
        }
      }
      toast({ title: "Clipboard has no image", variant: "destructive" });
    } catch {
      toast({
        title: "Couldn't read clipboard",
        description: "Paste into the box instead (Ctrl/Cmd+V).",
        variant: "destructive",
      });
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          onClick={(e) => e.stopPropagation()}
          title="Edit photo"
          className="text-curated-accent-strong"
          data-testid={`button-edit-photo-${id}`}
        >
          <ImagePlus className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-3"
        align="end"
        onClick={(e) => e.stopPropagation()}
        data-testid={`popover-edit-photo-${id}`}
      >
        <div className="space-y-2">
          <p className="text-xs font-semibold">Replace photo</p>
          <p className="text-xs text-muted-foreground">
            Paste an image URL, or paste a copied image below. Curated view only.
          </p>
          <Input
            type="url"
            placeholder="https://example.com/photo.jpg"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveUrl();
            }}
            data-testid={`input-edit-photo-url-${id}`}
          />
          <Button
            size="sm"
            variant="curated"
            className="w-full"
            onClick={() => void saveUrl()}
            disabled={busy}
            data-testid={`button-save-edit-photo-${id}`}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Use URL"}
          </Button>
          <div
            tabIndex={0}
            onPaste={onPaste}
            className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground focus:outline-none focus:ring-1 focus:ring-curated-accent"
            data-testid={`paste-edit-photo-${id}`}
          >
            Click here and press Ctrl/Cmd+V to paste an image
          </div>
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => void pasteFromClipboard()}
            disabled={busy}
            data-testid={`button-paste-edit-photo-${id}`}
          >
            <Copy className="h-3.5 w-3.5 mr-1.5" />
            Paste from clipboard
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function StoryDetailDialog({
  story,
  onClose,
  hasAccess,
  rankingCutoffs,
  initialScrollTop,
  onScrollRestored,
  preventDismiss,
}: {
  story: CuratedStory | null;
  onClose: () => void;
  hasAccess?: boolean;
  rankingCutoffs: { top5: number | null; top30: number | null };
  initialScrollTop?: number | null;
  onScrollRestored?: () => void;
  preventDismiss?: boolean;
}) {
  const [, navigate] = useLocation();
  // The scrollable popup body — captured so the reader's place in a long story
  // survives the round trip to the methodology guide and back.
  const contentRef = useRef<HTMLDivElement>(null);
  // Hand the currently-open story AND the reader's scroll position across the
  // route change to the methodology guide so the popup re-opens exactly where
  // they left it when they back out. See CURATED_PENDING_STORY_KEY for the
  // round-trip restore on the Curated side.
  const goToMethodology = (section: string) => {
    if (story) {
      try {
        sessionStorage.setItem(
          CURATED_PENDING_STORY_KEY,
          JSON.stringify({ story, scrollTop: contentRef.current?.scrollTop ?? 0 }),
        );
      } catch {
        /* sessionStorage unavailable — fall back to plain navigation */
      }
    }
    navigate(`/curated/methodology?section=${section}`);
  };

  // Re-apply the stashed scroll position once the recreated popup has laid out,
  // then tell the parent to clear it so a fresh open (or the reader scrolling)
  // isn't snapped back.
  useEffect(() => {
    if (!story || initialScrollTop == null) return;
    const id = requestAnimationFrame(() => {
      if (contentRef.current) contentRef.current.scrollTop = initialScrollTop;
      onScrollRestored?.();
    });
    return () => cancelAnimationFrame(id);
  }, [story, initialScrollTop, onScrollRestored]);
  // Legacy by-clusterId fetch — now only a FALLBACK. Top Stories embeds members
  // inline (story.members) from the same snapshot as the header, so we skip this
  // request whenever inline members are present (they always are for clusters).
  // This is what cured the stale-clusterId race: a tab holding an old clusterId
  // would get [] back here (the table is rewritten every clustering pass) and
  // collapse to a single-source fallback while the header kept the old count.
  const { data: members = [] } = useQuery<ClusterMember[]>({
    queryKey: ["/api/curated/cluster-members", { clusterId: story?.clusterId }],
    enabled: !!story?.clusterId && !(story?.members && story.members.length > 0),
  });

  const tz = useTimezone();
  const { toast } = useToast();
  // Track which same-outlet overflow groups the reader has expanded.
  // Keys are "${sectionKey}:${source}" — reset when the story changes so a
  // freshly opened cluster always starts collapsed.
  const [expandedOutlets, setExpandedOutlets] = useState<Set<string>>(new Set());
  useEffect(() => { setExpandedOutlets(new Set()); }, [story?.id]);
  const regionInfo = story ? focusLabel(story) : null;
  // Single-source detail view shows outlet background instead of a redundant
  // "1 contributing source" row that just repeats the headline. Resolved from
  // the same registry SourceIcon uses; undefined when the outlet isn't seeded.
  const outlet = useOutlet(story?.source ?? "", story?.url);
  // Registry index for per-member outlet lookups (Task #209): the cluster-members
  // API doesn't send each member's sourceIdentifier, so resolve it client-side
  // (same registry SourceIcon uses) to split out official social posts below.
  const outletIndex = useContext(OutletIndexContext);
  const outletOrigin = [outlet?.originCountry, outlet?.originRegion]
    .filter((v): v is string => !!v && v.trim().length > 0)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join(" · ");
  const outletFactuality = outlet?.factuality
    ? outlet.factuality
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ")
    : "";
  const outletOwnership = (outlet?.ownership ?? []).filter(Boolean).join(", ");
  const hasOutletDetails =
    !!outlet && (!!outletOrigin || !!outletFactuality || !!outletOwnership);

  const articles: ClusterMember[] =
    story?.members && story.members.length > 0
      ? story.members
      : story?.clusterId && members.length > 0
        ? members
        : story
          ? [
              {
                id: story.id,
                title: story.title,
                source: story.source,
                url: story.url,
                publishedAt: story.articlePublishedAt || story.scrapedAt,
                role: story.role,
              },
            ]
          : [];

  // The server-approved list is authoritative. Raw member photos remain on
  // source records but may belong to attach-only/contrast outlets.
  const heroImages = buildCuratedHeroImages(story, resolveArticleImage);

  // Curated lane (Task #121) — split members by their stamped DISPLAY trust-tier
  // into the three groups the intended model calls for:
  //   • contributing: reliable news + official primary-origin (Social/Release).
  //     These are shown together as the body of the story — primary-origin is
  //     surfaced prominently (flagged "Origin"), not buried.
  //   • contrast: CPC / low-factuality outlets shown AS PART OF the story, flagged
  //     for contrast/spin with an alignment breakdown. They carry no formation
  //     weight and never alter the facts — but they ARE part of the story.
  //   • attached: ONLY true "Other Source" (video/podcast/social/opinion/unknown)
  //     items that merely joined an already-formed story — genuinely
  //     non-contributing.
  // Falls back to the legacy `role` for the synthesized single-source row (which
  // carries no behaviorClass).
  const tierOf = (a: ClusterMember): "contributing" | "contrast" | "attached" => {
    const cls = a.behaviorClass;
    if (!cls) return a.role === "contributing" ? "contributing" : "attached";
    if (cls === "corroborating") return "contributing";
    if (cls === "anchor-only") return a.behaviorLabel === "contrast" ? "contrast" : "contributing";
    return "attached";
  };
  const contributingArticles = articles.filter((a) => tierOf(a) === "contributing");
  const contrastArticles = articles.filter((a) => tierOf(a) === "contrast");
  const attachedArticles = articles.filter((a) => tierOf(a) === "attached");
  // Related Official Statements (Task #209): split the attached (non-contributing)
  // members so official US social posts — X / Truth Social official accounts whose
  // outlet sourceIdentifier is `social-*` — render in their OWN subsection rather
  // than being buried in "Additional Coverage". DataMinr / OSINT flash wires
  // (other/social) are NOT official statements and stay in Additional Coverage. A
  // social post is attach-only, so it is always within the attached tier and can
  // never be the story's representative/face.
  const isOfficialStatement = (a: ClusterMember): boolean => {
    const o = outletIndex ? findOutlet(outletIndex, a.source, a.url) : undefined;
    const sid = o?.sourceIdentifier;
    return typeof sid === "string" && sid.startsWith("social-");
  };
  const officialStatementArticles = attachedArticles.filter(isOfficialStatement);
  const otherAttachedArticles = attachedArticles.filter((a) => !isOfficialStatement(a));

  // A clustered (multi-source) story has no single "published" moment, so we show
  // when it was FIRST seen = the earliest member publishedAt.
  const isClustered = !!story && story.sourceCount > 1;
  const firstSeenMs = articles.reduce((min, a) => {
    const t = new Date(a.publishedAt).getTime();
    return Number.isFinite(t) && t < min ? t : min;
  }, Infinity);
  const firstSeenAt = Number.isFinite(firstSeenMs) ? new Date(firstSeenMs) : null;

  // The story's summary points, in the same precedence the detail view renders:
  // corroborated facts → AI summary bullets → plain summary.
  const detailBullets = (s: CuratedStory): string[] => {
    if (s.facts && s.facts.length > 0) return s.facts;
    if (s.summaryBullets && s.summaryBullets.length > 0) return s.summaryBullets;
    return s.summary ? [s.summary] : [];
  };

  // Copy-to-share payload for a SINGLE-source story: bold + hyperlinked
  // headline, "OUTLET · <date-time>" metadata, then the summary bullets.
  const buildSingleCopyHtml = (): string => {
    if (!story) return "";
    const headline = story.headline || story.displayTitle || story.title;
    const when = formatShareDateTime(story.articlePublishedAt || story.scrapedAt, tz);
    const meta = [story.source, when].filter(Boolean).join(" · ");
    const lines: string[] = [
      `<div><b><a href="${escapeHtml(story.url)}">${escapeHtml(headline)}</a></b></div>`,
    ];
    if (meta) lines.push(`<div>${escapeHtml(meta)}</div>`);
    detailBullets(story).forEach((b) => lines.push(`<div>• ${escapeHtml(b)}</div>`));
    return lines.join("");
  };

  // Copy-to-share payload for a CLUSTERED story: bold (not linked — a cluster has
  // no single canonical URL) generalized headline, "Updated <date-time>", the
  // corroborated facts/bullets, then a [Sources: …] line where each CONTRIBUTING
  // outlet name links to its own article.
  const buildClusterCopyHtml = (): string => {
    if (!story) return "";
    const headline = story.headline || story.displayTitle || story.title;
    const when = formatShareDateTime(story.scrapedAt, tz);
    const lines: string[] = [`<div><b>${escapeHtml(headline)}</b></div>`];
    if (when) lines.push(`<div>Updated ${escapeHtml(when)}</div>`);
    detailBullets(story).forEach((b) => lines.push(`<div>• ${escapeHtml(b)}</div>`));
    const sources = contributingArticles
      .filter((a) => a.url)
      .map((a) => `<a href="${escapeHtml(a.url)}">${escapeHtml(a.source)}</a>`);
    if (sources.length > 0) {
      lines.push(`<div>[Sources: ${sources.join(", ")}]</div>`);
    }
    return lines.join("");
  };

  // Allowlist-gated HIDE / UN-HIDE of an individual cluster member photo
  // (Task #380 expansion). Curated-view only — hits the dedicated curated endpoint;
  // the read path then drops the URL from every card thumbnail + carousel. Replace
  // is single-source only (EditPhotoControl); clusters only ever HIDE.
  const hideImageMutation = useMutation({
    mutationFn: async ({ imageUrl, hidden }: { imageUrl: string; hidden: boolean }) => {
      const res = await apiRequest("POST", "/api/curated/hide-image", { imageUrl, hidden });
      return res.json();
    },
    onMutate: async (vars) => {
      // Optimistic update for both hide and restore directions — update memberImages
      // and hiddenImages immediately so the carousel and card photo update
      // instantly without waiting for the server round-trip.
      await queryClient.cancelQueries({ queryKey: ["/api/curated/top-stories"] });
      const prev = queryClient.getQueryData(["/api/curated/top-stories", { hours: 24, limit: 100 }]);
      queryClient.setQueriesData<{ stories?: CuratedStory[] } & Record<string, unknown>>(
        { queryKey: ["/api/curated/top-stories"] },
        (old) => {
          if (!old?.stories) return old;
          return {
            ...old,
            stories: old.stories.map((s: CuratedStory) => {
              if (vars.hidden) {
                // Hide: remove from memberImages, add to hiddenImages.
                const imgs = s.memberImages;
                if (!imgs || !imgs.includes(vars.imageUrl)) return s;
                return {
                  ...s,
                  memberImages: imgs.filter((u) => u !== vars.imageUrl),
                  hiddenImages: [...(s.hiddenImages ?? []), vars.imageUrl],
                };
              } else {
                // Restore: remove from hiddenImages, append to memberImages.
                const hidden = s.hiddenImages;
                if (!hidden || !hidden.includes(vars.imageUrl)) return s;
                return {
                  ...s,
                  hiddenImages: hidden.filter((u) => u !== vars.imageUrl),
                  memberImages: [...(s.memberImages ?? []), vars.imageUrl],
                };
              }
            }),
          };
        },
      );
      return { prev };
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/curated/top-stories"] });
      queryClient.invalidateQueries({ queryKey: ["/api/curated/cluster-members"] });
      toast({
        title: vars.hidden ? "Photo hidden" : "Photo restored",
        description: "Curated view only.",
      });
    },
    onError: (_err, _vars, context) => {
      if (context && "prev" in context && context.prev !== undefined) {
        queryClient.setQueryData(["/api/curated/top-stories", { hours: 24, limit: 100 }], context.prev);
      }
      toast({ title: "Failed to update photo", variant: "destructive" });
    },
  });

  // The small, inconspicuous moderation overlay rendered on the detail hero: fix
  // labels, hide the story, pin priority, and (single-source only) replace the
  // photo. Allowlist-gated by the caller (`hasAccess`); curated-view only.
  // Task #904: all controls are icon-sized + accent-blue; toolbar never wraps.
  const renderModerationControls = (s: CuratedStory) => (
    <>
      <CuratedEditControl story={s} />
      <CuratedContentKindOverrideControl story={s} />
      <CuratedHideControl story={s} variant="icon" />
      <CuratedManualLinkControl story={s} />
      <CuratedPriorityBadge story={s} rankingCutoffs={rankingCutoffs} />
      {s.sourceCount <= 1
        ? <EditPhotoControl type={s.type} id={s.id} />
        : s.clusterId
          ? <EditPhotoControl type={s.type} id={s.id} clusterId={s.clusterId} />
          : null}
    </>
  );

  return (
    <Dialog
      open={!!story}
      onOpenChange={(o) => {
        if (o) return;
        // During the guided tour the walkthrough drives this dialog open/closed
        // programmatically; a stray outside-click or Escape must NOT dismiss it
        // and dump the viewer back to the page mid-walkthrough.
        if (preventDismiss) return;
        onClose();
      }}
    >
      <DialogContent
        ref={contentRef}
        className="curated-surface bg-background text-foreground border-2 border-curated-accent/50 max-w-3xl w-[95vw] max-h-[90vh] overflow-y-auto"
        onInteractOutside={(e) => {
          if (preventDismiss) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (preventDismiss) e.preventDefault();
        }}
        data-testid="dialog-story-detail"
      >
        {story && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2 flex-wrap mb-1">
                {/* Category = the story's specific content subject, accent-blue metadata text */}
                <span className="text-xs font-mono font-semibold text-curated-accent-strong" data-testid="text-detail-topic">
                  {storyTopicLabel(story)}
                </span>
                {/* The conflict-track chip was removed (Task #336 follow-up): the
                    Focus below already renders the conflict pair (e.g.
                    "U.S.–Iran"), so a "U.S.–Iran Conflict" badge in the middle of
                    the row was redundant. `conflictTrack` still drives the Focus
                    derivation (focusLabel) — only the duplicate chip is gone. */}
                <span className="text-xs text-curated-accent-strong font-mono">·</span>
                {/* Focus (Task #336): a country / region / two-country pair /
                    "Global" — content-based, never the outlet's origin. A
                    deterministic keyword fallback (incl. a U.S./domestic path)
                    fills it when unclassified; it is a real derivation, so a real
                    story never renders the DEMO tag here. */}
                <span className="text-xs font-mono text-curated-accent-strong" data-testid="text-detail-region">
                  {regionInfo?.label}
                </span>
                {regionInfo?.isPlaceholder && <DemoTag />}
                {/* Single outlet name only for single-source stories. Clustered
                    stories are multi-outlet — the "N sources" count below speaks
                    for them, so we never pin a clustered story to one outlet. */}
                {story.sourceCount === 1 && (
                  <span className="text-xs text-curated-muted font-mono" data-testid="text-detail-source">
                    · {story.source}
                  </span>
                )}
                {isClustered || !story.articlePublishedAt ? (
                  // Clustered stories always show "First seen" (when MCOP first
                  // spotted the story). Standalone stories fall into this branch
                  // too when we have NO trustworthy original-publish timestamp —
                  // showing scrapedAt labeled "Published" would fabricate a fresh
                  // publish time for a possibly-stale article (Task #653). Honest
                  // fallback: label it "First seen" instead.
                  <span className="text-xs text-curated-muted font-mono" data-testid="text-detail-firstseen">
                    · {formatDetailProvenanceTime(
                      firstSeenAt ?? (story.articlePublishedAt || story.scrapedAt),
                      tz,
                      "First seen",
                    )}
                  </span>
                ) : (
                  <span className="text-xs text-curated-muted font-mono" data-testid="text-detail-published">
                    · {formatDetailProvenanceTime(story.articlePublishedAt, tz, "Published")}
                  </span>
                )}
                {/* "Updated" reflects the freshest CONTRIBUTING content the synopsis
                    actually incorporated (Task #920) — never the representative's
                    scrape time, which advertised a freshness the text lacked. The
                    server derives articlePublishedAt for clusters from the
                    synthesized-through marker so this can't lead the synopsis
                    content. Meaningful only for multi-source stories. */}
                {isClustered && (
                  <span className="text-xs text-curated-muted font-mono" data-testid="text-detail-updated">
                    · {formatDetailProvenanceTime(
                      story.articlePublishedAt || story.scrapedAt,
                      tz,
                      "Updated",
                    )}
                  </span>
                )}
                {story.sourceCount > 1 && (
                  <span className="text-xs text-curated-muted font-mono" data-testid="text-detail-sources">
                    · {story.sourceCount} sources
                  </span>
                )}
                {/* Info icon deep-linking to the content-metadata methodology section
                    so the "content-metadata" section is not orphaned. */}
                <MethodologyInfoIcon
                  section="content-metadata"
                  onNavigate={goToMethodology}
                  testId="info-content-metadata"
                >
                  Topic and Focus describe <em>what</em> the story is about and{" "}
                  <em>where</em> its impact lands — not the outlet's nationality.
                  The source count tells you how many trusted outlets back a
                  multi-source story.
                </MethodologyInfoIcon>
                {/* Allowlist-gated Priority badge (Task #171) — both standalone and
                    clustered stories are editable from the detail view; pushed to
                    the top-right of the metadata row. */}
                {/* Copy-to-share stays a PUBLIC affordance for clustered stories.
                    The allowlist-gated moderation controls (labels / hide / priority
                    / photo) moved OUT of this metadata row and onto the hero image
                    as a small overlay so the editor's view ≈ the public view
                    (Task #380 expansion). */}
                {isClustered && (
                  <span className="ml-auto flex items-center gap-1 flex-wrap">
                    <CopyShareButton
                      testId="button-copy-cluster"
                      label="Copy story to clipboard"
                      buildHtml={buildClusterCopyHtml}
                    />
                  </span>
                )}
              </div>
              {/* Clustered stories use the short synthesized generalized headline
                  as the title (no single source's framing) — identical to what the
                  curated cards show. Single-source rows keep the article's own
                  title. The full lede appears beneath the image below. */}
              <DialogTitle className="text-xl leading-snug" data-testid="text-detail-title">
                {story.headline || story.displayTitle || story.title}
              </DialogTitle>
            </DialogHeader>

            {/* Hero image (carousel for clusters). Allowlist-gated moderation
                controls sit as a small, inconspicuous overlay in the corner so the
                editor view ≈ the public view (Task #380 expansion). When the story
                has no photo, the controls fall back to a compact inline row so a
                single-source story can still be GIVEN a photo. */}
            {heroImages.length > 0 ? (
              <div className="relative">
                <ImageCarousel
                  images={heroImages}
                  className="w-full h-72 rounded-md bg-muted"
                  testId="img-detail"
                  onHideImage={
                    hasAccess && isClustered
                      ? (u) => hideImageMutation.mutate({ imageUrl: u, hidden: true })
                      : undefined
                  }
                />
                {hasAccess && (
                  <div
                    className="absolute top-2 right-2 z-20 flex items-center justify-end gap-0.5 flex-nowrap rounded-md bg-black/50 backdrop-blur-sm p-0.5 border border-curated-accent/20"
                    data-testid="overlay-moderation"
                  >
                    {renderModerationControls(story)}
                  </div>
                )}
              </div>
            ) : (
              hasAccess && (
                <div
                  className="flex items-center justify-end gap-0.5 flex-nowrap rounded-md bg-muted/60 border border-curated-accent/20 p-0.5"
                  data-testid="overlay-moderation"
                >
                  {renderModerationControls(story)}
                </div>
              )
            )}

            {/* Hidden-photo un-hide strip (clusters). Quick restore of any cluster
                member photo an editor hid (drives it back into the previews /
                carousel). Driven by story.hiddenImages (raw member-photo candidates
                ∩ the curated hidden-images overlay). Editors only; never public. */}
            {hasAccess && isClustered && (story.hiddenImages?.length ?? 0) > 0 && (
              <div
                className="flex items-center gap-2 flex-wrap rounded-md border border-border p-2"
                data-testid="strip-hidden-photos"
              >
                <span className="text-xs font-mono text-muted-foreground">
                  Hidden photos
                </span>
                {story.hiddenImages!.map((u) => (
                  <div key={u} className="relative">
                    <img
                      src={u}
                      alt=""
                      className="h-10 w-16 object-cover rounded-sm opacity-60"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        hideImageMutation.mutate({ imageUrl: u, hidden: false })
                      }
                      className="absolute -top-1.5 -right-1.5 inline-flex items-center justify-center h-5 w-5 rounded-full bg-black/70 backdrop-blur-sm text-white border border-white/20"
                      title="Un-hide photo"
                      data-testid="button-unhide-photo"
                    >
                      <Eye className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* The neutral synthesized lede (clustered stories only) sits under
                the headline/image as a body paragraph. Single-source rows have no
                lede so this is skipped for them. */}
            {story.lede && (
              <p className="text-base leading-relaxed" data-testid="text-detail-lede">
                {story.lede}
              </p>
            )}

            {/* Curated lane (Task #90) — facts corroborated across DIVERSE
                contributing source types. Falls back to the representative's own
                AI summary when synthesis hasn't produced corroborated facts. */}
            {story.facts && story.facts.length > 0 ? (
              <div data-testid="list-detail-facts">
                <h4 className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-curated-accent-strong mb-2">
                  Corroborated Facts
                  <MethodologyInfoIcon
                    section="how-a-story-is-built"
                    onNavigate={goToMethodology}
                    testId="info-corroborated-facts"
                  >
                    The plain-language facts that held up across the contributing
                    outlets covering this story — what they agree happened, drawn
                    from their reporting rather than any single outlet's wording or
                    framing.
                  </MethodologyInfoIcon>
                </h4>
                <ul className="list-disc pl-5 space-y-1.5">
                  {story.facts.map((f, i) => (
                    <li key={i} className="text-sm leading-relaxed">
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            ) : story.summaryBullets && story.summaryBullets.length > 0 ? (
              <ul className="list-disc pl-5 space-y-1.5" data-testid="list-detail-bullets">
                {story.summaryBullets.map((b, i) => (
                  <li key={i} className="text-sm leading-relaxed">
                    {b}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm leading-relaxed text-muted-foreground" data-testid="text-detail-summary">
                {story.summary}
              </p>
            )}

            {/* Curated lane (Task #256) — attributed claims / key statements.
                ADDITIVE: rendered beneath the summary/Corroborated Facts and
                kept SEPARATE from them — each line preserves its source
                attribution and is never a corroborated fact. Hidden when empty. */}
            {story.attributedClaims && story.attributedClaims.length > 0 && (
              <div className="mt-4" data-testid="list-detail-attributed-claims">
                <h4 className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-curated-accent-strong mb-2">
                  Attributed Claims & Key Statements
                  <MethodologyInfoIcon
                    section="how-a-story-is-built"
                    onNavigate={goToMethodology}
                    testId="info-attributed-claims"
                  >
                    Direct statements and assertions tied to a specific person or
                    outlet — what someone said or claimed. Kept separate from the
                    corroborated facts because an attributed claim is a quote or
                    position, not something independently confirmed across sources.
                  </MethodologyInfoIcon>
                </h4>
                <ul className="list-disc pl-5 space-y-1.5">
                  {story.attributedClaims.map((c, i) => (
                    <li key={i} className="text-sm leading-relaxed" data-testid={`text-detail-attributed-claim-${i}`}>
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* A single-source story keeps the plain "Open article" button. A
                clustered story has NO single canonical article — its per-outlet
                links live in the contributing-source rows below, so we don't
                repeat them as a logo grid here. */}
            {articles.length <= 1 && (
              story.linkDead ? (
                // Curated lane (Task #226) — dead link. Show an unavailable state
                // instead of "Open article"; allowlisted users get a Replace
                // control to swap in a working URL.
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
                    data-testid="text-detail-link-unavailable"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                    Link unavailable
                  </span>
                  {hasAccess && story.type === "curated" && (
                    <ReplaceLinkControl itemId={story.id} />
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    asChild
                    size="sm"
                    variant="curated"
                    data-testid="button-detail-open"
                  >
                    <a href={story.url} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                      Open article
                    </a>
                  </Button>
                  <Button
                    size="sm"
                    variant="curated"
                    data-testid="button-copy-single"
                    onClick={() => void copyRichText(buildSingleCopyHtml(), toast)}
                  >
                    <Copy className="h-3.5 w-3.5 mr-1.5" />
                    Copy Summary to Clipboard
                  </Button>
                </div>
              )
            )}

            {/* Single-source stories show outlet background here instead of a
                "1 Contributing Source" row that just repeats the headline. The
                contributing/attached source lists and the Videos & Opinions pane
                below only make sense for multi-source clustered stories. */}
            {!isClustered && hasOutletDetails && (
              <div data-testid="section-detail-outlet">
                <h4 className="text-sm font-bold uppercase tracking-wider text-curated-accent-strong mb-2 mt-1">
                  About This Source
                </h4>
                <div className="rounded-md border border-border p-3">
                  <div className="flex items-center gap-2.5">
                    <SourceIcon source={story.source} url={story.url} sizeClass="h-9 w-9" />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold" data-testid="text-detail-outlet-name">
                        {story.source}
                      </div>
                      {outletOrigin && (
                        <div className="text-xs text-curated-accent-strong font-mono" data-testid="text-detail-outlet-origin">
                          {outletOrigin}
                        </div>
                      )}
                    </div>
                  </div>
                  {(outletFactuality || outletOwnership) && (
                    <dl className="mt-2.5 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
                      {outletFactuality && (
                        <>
                          <dt className="text-muted-foreground">Factuality</dt>
                          <dd data-testid="text-detail-outlet-factuality">{outletFactuality}</dd>
                        </>
                      )}
                      {outletOwnership && (
                        <>
                          <dt className="text-muted-foreground">Ownership</dt>
                          <dd data-testid="text-detail-outlet-ownership">{outletOwnership}</dd>
                        </>
                      )}
                    </dl>
                  )}
                </div>
              </div>
            )}

            {isClustered && (() => {
              const toggleOutlet = (expandKey: string, e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                setExpandedOutlets((prev) => {
                  const next = new Set(prev);
                  if (next.has(expandKey)) next.delete(expandKey);
                  else next.add(expandKey);
                  return next;
                });
              };

              const renderArticleRow = (
                a: ClusterMember,
                opts?: { groupSize?: number },
              ) => {
                // When this row is the newest item of a multi-item outlet group,
                // signal that with stacked logos + a count chip so the reader can
                // see there's more coverage from this outlet before expanding.
                const groupSize = opts?.groupSize ?? 1;
                const isGrouped = groupSize > 1;
                // Primary-origin (official Social/Release) is the originating event
                // of the story — flag it so it reads as the source, not a peer.
                const isOrigin =
                  a.behaviorClass === "anchor-only" && a.behaviorLabel === "primary";
                const kind = getEffectiveContentKindWithTitle(a.url, a.title, toStoredContentKind(a.contentKind));
                // Social rows store the post body as their title. Their standalone
                // summary often repeats that same body, so rendering both makes an
                // attached post look duplicated. The title is the complete social
                // content for this compact row; article summaries remain unchanged.
                const showMemberSummary =
                  kind === "article" && !isSocialPostIdentityUrl(a.url);
                // Curated lane (Task #226) — a curated member whose link a probe
                // confirmed dead. The row becomes non-clickable and shows an
                // "unavailable" footer; allowlisted users get a Replace control.
                const isDead = !!a.linkDead && a.itemType === "curated";
                // Editor-only "Remove from story" (Task #955): only offer it on a
                // multi-member cluster where at least two SIBLINGS remain to anchor
                // the eviction to THIS story. Anchors = every other member's URL.
                const canEvict = !!hasAccess && articles.length >= 3 && !!a.url;
                const evictAnchorUrls = canEvict
                  ? articles.filter((x) => x.url && x.url !== a.url).map((x) => x.url)
                  : [];
                const evictStoryLabel =
                  story?.headline || story?.displayTitle || story?.title || "";
                const body = (
                  <>
                    {/* Each contributing outlet's own logo, linking to its article.
                        For a multi-item outlet group the newest row shows stacked
                        logos to hint at the additional coverage behind it. */}
                    {isGrouped ? (
                      <StackedSourceIcon source={a.source} url={a.url} />
                    ) : (
                      <SourceIcon source={a.source} url={a.url} sizeClass="h-8 w-8" className="mt-0.5" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-mono text-curated-accent-strong shrink-0">
                          {a.source}
                        </span>
                        <span className="text-xs font-mono text-curated-accent-strong shrink-0">
                          · {formatDetailTime(a.publishedAt, tz)}
                        </span>
                        {isOrigin && (
                          <Badge variant="secondary" data-testid={`badge-origin-${a.id}`}>
                            Origin
                          </Badge>
                        )}
                        <ContentKindBadge kind={kind} />
                        {/* Editor-only per-member controls (Tasks #955/#957) —
                            one compact icon row on the metadata line:
                            Tags = content-kind mark, Unlink = unlink from
                            cluster, Minus = remove from story. Click handlers
                            stop propagation so the row link never fires. */}
                        {hasAccess && (
                          <span
                            className="inline-flex items-center gap-1"
                            onClick={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                            }}
                            data-testid={`row-member-editor-controls-${a.id}`}
                          >
                            {/* Attach-only members can be detached or moved, but
                                their attach-only classification is not editable. */}
                            {tierOf(a) === "contributing" && (
                              <MemberKindControl memberUrl={a.url} />
                            )}
                            {canEvict && (
                              <EvictMemberControl
                                evictedUrl={a.url}
                                anchorUrls={evictAnchorUrls}
                                storyLabel={evictStoryLabel}
                                memberId={a.id}
                              />
                            )}
                            {/* Editor-only "Move to another story" — atomic
                                remove-from-here + join-that-story in one
                                decision (dedicated move overlay, never an
                                evict+link composite). Offered on any member
                                with a URL; the dialog itself hides when no
                                other formed story can receive it. */}
                            {!!a.url && story && (
                              <MoveMemberControl
                                itemUrl={a.url}
                                sourceAnchorUrls={articles
                                  .filter((x) => x.url && x.url !== a.url)
                                  .map((x) => x.url)}
                                currentStoryKey={storyKey(story)}
                                memberId={a.id}
                              />
                            )}
                          </span>
                        )}
                      </div>
                      {/* Each outlet's own headline + click-out (the row link). */}
                      <div className="text-sm leading-snug mt-0.5">{a.displayTitle || a.title}</div>
                      {/* This outlet's own photo is intentionally NOT shown here —
                          all cluster photos rotate on the hero carousel above so
                          the source list stays compact and scannable. */}
                      {/* Curated lane (Task #126) — 3-bullet AI summary when present,
                          else this outlet's OWN standalone lede. Non-article items
                          (video / opinion) are shown compact, WITHOUT a lede. */}
                      {showMemberSummary &&
                        (a.summaryBullets && a.summaryBullets.length > 0 ? (
                          <ul
                            className="list-disc pl-5 mt-1 space-y-0.5 text-xs text-muted-foreground leading-snug"
                            data-testid={`list-detail-bullets-${a.id}`}
                          >
                            {a.summaryBullets.map((b, i) => (
                              <li key={i}>{b}</li>
                            ))}
                          </ul>
                        ) : (
                          a.summary && (
                            <div
                              className="text-xs text-muted-foreground leading-snug mt-1 line-clamp-3"
                              data-testid={`text-detail-lede-${a.id}`}
                            >
                              {a.summary}
                            </div>
                          )
                        ))}
                      {/* Curated lane (Task #90) — one-sentence characterization of
                          THIS outlet's spin on the story. */}
                      {a.spin && (
                        <div
                          className="text-xs italic text-muted-foreground leading-snug mt-1"
                          data-testid={`text-detail-spin-${a.id}`}
                        >
                          {a.spin}
                        </div>
                      )}
                      {/* Curated lane (Task #226) — dead-link footer. */}
                      {isDead && (
                        <div className="flex items-center gap-2 flex-wrap mt-1.5">
                          <span
                            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
                            data-testid={`text-member-link-unavailable-${a.id}`}
                          >
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                            Link unavailable
                          </span>
                          {hasAccess && <ReplaceLinkControl itemId={a.id} />}
                        </div>
                      )}
                    </div>
                  </>
                );
                const rowEl = isDead ? (
                  <div
                    key={a.id}
                    className="flex items-start gap-2.5 rounded-md p-2"
                    data-testid={`row-detail-article-${a.id}`}
                  >
                    {body}
                  </div>
                ) : (
                  <a
                    key={a.id}
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-start gap-2.5 rounded-md p-2 hover-elevate"
                    data-testid={`row-detail-article-${a.id}`}
                  >
                    {body}
                  </a>
                );
                // The evict control now lives on the metadata icon row inside
                // the row body (stopPropagation-guarded), so no below-row
                // sibling wrapper is needed anymore.
                return rowEl;
              };

              // CPC/contrast sources have their own row renderer, so inject only
              // the same membership controls regular rows use. Their trust/role
              // classification remains immutable here.
              const renderAttachOnlyMemberControls = (a: ClusterMember) => {
                if (!hasAccess || !a.url || !story) return null;
                const anchorUrls = articles
                  .filter((x) => x.url && x.url !== a.url)
                  .map((x) => x.url);
                const canEvict = articles.length >= 3;
                return (
                  <span
                    className="inline-flex items-center gap-1"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                    }}
                    data-testid={`row-member-editor-controls-${a.id}`}
                  >
                    {canEvict && (
                      <EvictMemberControl
                        evictedUrl={a.url}
                        anchorUrls={anchorUrls}
                        storyLabel={story.headline || story.displayTitle || story.title || ""}
                        memberId={a.id}
                      />
                    )}
                    <MoveMemberControl
                      itemUrl={a.url}
                      sourceAnchorUrls={anchorUrls}
                      currentStoryKey={storyKey(story)}
                      memberId={a.id}
                    />
                  </span>
                );
              };

              // Render a section's member list with same-outlet collapsing.
              // Outlets with a single item render exactly as before; outlets with
              // multiple items show only their newest item by default and expose
              // an expander that reveals the rest, newest-to-oldest.
              // Shared expander control rendered under an outlet's newest row.
              // An accent-colored pill — deliberately prominent — that toggles the
              // outlet's older items into / out of view.
              const renderOutletExpander = (
                expandKey: string,
                sectionKey: string,
                safeSource: string,
                source: string,
                hiddenCount: number,
                isExpanded: boolean,
              ) => (
                <button
                  type="button"
                  className="ml-10 mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-curated-accent/40 bg-curated-accent/10 px-2.5 py-1 text-xs font-semibold text-curated-accent-strong hover-elevate active-elevate-2"
                  onClick={(e) => toggleOutlet(expandKey, e)}
                  data-testid={`button-outlet-expand-${sectionKey}-${safeSource}`}
                  aria-expanded={isExpanded}
                >
                  {isExpanded
                    ? <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                    : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                  {isExpanded
                    ? `Hide older coverage from ${source}`
                    : `Show ${hiddenCount} more from ${source}`}
                </button>
              );

              const renderGroupedRows = (members: ClusterMember[], sectionKey: string) => {
                const groups = groupByOutlet(members);
                return groups.map(({ source, items }) => {
                  if (items.length === 1) return renderArticleRow(items[0]);
                  const expandKey = `${sectionKey}:${source}`;
                  const isExpanded = expandedOutlets.has(expandKey);
                  const olderItems = items.slice(1);
                  const safeSource = source.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-]/g, "");
                  return (
                    <div key={`group-${sectionKey}-${source}`}>
                      {renderArticleRow(items[0], { groupSize: items.length })}
                      {renderOutletExpander(expandKey, sectionKey, safeSource, source, olderItems.length, isExpanded)}
                      {isExpanded && (
                        <div
                          className="space-y-1.5 mt-1"
                          data-testid={`region-outlet-expanded-${sectionKey}-${safeSource}`}
                        >
                          {olderItems.map((a) => renderArticleRow(a))}
                        </div>
                      )}
                    </div>
                  );
                });
              };

              // Same grouping logic for the contrast section which uses
              // ContrastSourceRow instead of renderArticleRow.
              const renderGroupedContrastRows = (members: ClusterMember[], sectionKey: string) => {
                const groups = groupByOutlet(members);
                return groups.map(({ source, items }) => {
                  if (items.length === 1)
                    return (
                      <ContrastSourceRow
                        key={items[0].id}
                        a={items[0]}
                        tz={tz}
                        editorControls={renderAttachOnlyMemberControls(items[0])}
                      />
                    );
                  const expandKey = `${sectionKey}:${source}`;
                  const isExpanded = expandedOutlets.has(expandKey);
                  const olderItems = items.slice(1);
                  const safeSource = source.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-]/g, "");
                  return (
                    <div key={`group-${sectionKey}-${source}`}>
                      <ContrastSourceRow
                        a={items[0]}
                        tz={tz}
                        groupSize={items.length}
                        editorControls={renderAttachOnlyMemberControls(items[0])}
                      />
                      {renderOutletExpander(expandKey, sectionKey, safeSource, source, olderItems.length, isExpanded)}
                      {isExpanded && (
                        <div
                          className="space-y-1.5 mt-1"
                          data-testid={`region-outlet-expanded-${sectionKey}-${safeSource}`}
                        >
                          {olderItems.map((a) => (
                            <ContrastSourceRow
                              key={a.id}
                              a={a}
                              tz={tz}
                              editorControls={renderAttachOnlyMemberControls(a)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                });
              };

              return (
                <div className="space-y-4">
                  <div>
                    <h4 className="flex items-center flex-wrap gap-x-1.5 gap-y-0.5 text-sm font-bold uppercase tracking-wider text-curated-accent-strong mb-2 mt-1">
                      <span>
                        {contributingArticles.length}{" "}
                        {contributingArticles.length === 1 ? "Contributing Source" : "Contributing Sources"}
                      </span>
                      <MethodologyInfoIcon
                        section="contributing-vs-attached-sources"
                        onNavigate={goToMethodology}
                        testId="info-contributing-sources"
                      >
                        Trusted, reporting outlets whose coverage let this story
                        form. They rate high or very-high for factuality across
                        Media Bias/Fact Check and Ad Fontes Media, confirmed by
                        MCOP's editorial review, and are genuine reporting outlets
                        rather than opinion shops, social accounts, or
                        state-controlled media. For each, we show its own headline,
                        when it published, and a short AI summary of its report.
                        Sources attached for context can join a story but never
                        create one and never alter the corroborated facts.
                      </MethodologyInfoIcon>
                    </h4>
                    <div className="space-y-1.5" data-testid="list-detail-contributing">
                      {renderGroupedRows(contributingArticles, "contributing")}
                    </div>

                    {/* Curated lane — biased / low-factuality outlets shown AS PART
                        OF the story so the reader can see how it's being spun.
                        Nested under Contributing behind a red warning bar; each
                        flagged outlet's avatar carries a matching red ring. They
                        never alter the corroborated facts. */}
                    {contrastArticles.length > 0 && (
                      <>
                        <div
                          className="mt-3 mb-2 flex items-start gap-1.5 rounded-md border border-curated-contrast/40 bg-curated-contrast/10 px-2.5 py-1.5"
                          data-testid="banner-flagged-sources"
                        >
                          <span className="text-[11px] leading-snug text-curated-contrast">
                            Outlets controlled by biased entities, lack credible
                            sources / objectivity, known to frequently mislead
                            readers and distort facts.
                          </span>
                          <MethodologyInfoIcon
                            section="contributing-vs-attached-sources"
                            onNavigate={goToMethodology}
                            testId="info-flagged-sources"
                          >
                            Outlets with mixed or lower factuality, biased or
                            state ownership, or opinion and social formats. They are
                            shown attached to the story — never as contributing
                            sources — so you can see how it is being spun, and they
                            never alter the corroborated facts. Official releases are
                            a special case: as the origin of the news they can anchor
                            a story, but like other attached sources they never
                            inform the corroborated facts.
                          </MethodologyInfoIcon>
                        </div>
                        <div className="space-y-1.5" data-testid="list-detail-contrast">
                          {renderGroupedContrastRows(contrastArticles, "contrast")}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Related Official Statements (Task #209) — official US social
                      posts (X / Truth Social) that joined this story. Attach-only:
                      they react to / amplify the story but never seed it or act as
                      its representative. */}
                  {officialStatementArticles.length > 0 && (
                    <div>
                      <h4 className="flex items-center flex-wrap gap-x-1.5 gap-y-0.5 text-sm font-bold uppercase tracking-wider text-curated-accent-strong mb-2">
                        <span>
                          {officialStatementArticles.length} Related Official{" "}
                          {officialStatementArticles.length === 1 ? "Statement" : "Statements"}
                        </span>
                        <span className="font-normal normal-case text-xs text-muted-foreground">
                          (official social posts — never alters the corroborated facts)
                        </span>
                      </h4>
                      <div className="space-y-1.5" data-testid="list-detail-official-statements">
                        {renderGroupedRows(officialStatementArticles, "official")}
                      </div>
                    </div>
                  )}

                  {otherAttachedArticles.length > 0 && (
                    <div>
                      <h4 className="flex items-center flex-wrap gap-x-1.5 gap-y-0.5 text-sm font-bold uppercase tracking-wider text-curated-accent-strong mb-2">
                        <span>
                          {otherAttachedArticles.length} Additional{" "}
                          {otherAttachedArticles.length === 1 ? "Coverage" : "Coverage"}
                        </span>
                        <span className="font-normal normal-case text-xs text-muted-foreground">
                          (attached / non-contributing)
                        </span>
                      </h4>
                      <div className="space-y-1.5" data-testid="list-detail-attached">
                        {renderGroupedRows(otherAttachedArticles, "attached")}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Simple flat U.S. flag drawn as line art (matches lucide stroke icons)
function UsFlagIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="14" rx="1" />
      <rect x="13" y="5" width="8" height="5" />
      <line x1="3" y1="12.3" x2="13" y2="12.3" />
      <line x1="3" y1="15.6" x2="21" y2="15.6" />
    </svg>
  );
}

// Outlet Registry index, provided once at the page root so any descendant
// (SourceIcon, region labels) can resolve a source string to its canonical
// registry row. Null until the registry has loaded.
const OutletIndexContext = createContext<OutletIndex | null>(null);

function useOutlet(source: string, url?: string | null): OutletRegistry | undefined {
  const index = useContext(OutletIndexContext);
  return index ? findOutlet(index, source, url) : undefined;
}

// Outlet icon shown at the start of a headline. Uses a real logo when one is
// registered in the shared outlet registry, otherwise an initials fallback.
// Sized to roughly match the X account avatars (h-8 w-8).
function SourceIcon({
  source,
  url,
  className = "",
  sizeClass = "h-8 w-8",
  textClass = "text-[10px]",
}: {
  source: string;
  url?: string | null;
  className?: string;
  sizeClass?: string;
  textClass?: string;
}) {
  const outlet = useOutlet(source, url);
  return (
    <OutletLogo
      outlet={outlet}
      source={source}
      sizeClass={sizeClass}
      textClass={textClass}
      className={className}
    />
  );
}

// A SourceIcon visually "stacked" on top of two offset muted squares so a
// multi-item outlet group reads, at a glance, as a pile of coverage from one
// outlet rather than a single article. Purely decorative — the count chip and
// expander carry the actual meaning.
function StackedSourceIcon({
  source,
  url,
  iconClassName = "",
  tone = "neutral",
}: {
  source: string;
  url?: string | null;
  iconClassName?: string;
  tone?: "neutral" | "contrast";
}) {
  const peekClass =
    tone === "contrast"
      ? "bg-curated-contrast/10 border border-curated-contrast/40"
      : "bg-muted border border-border";
  return (
    <div className="relative h-8 w-8 shrink-0 mt-0.5" data-testid="stacked-source-icon">
      {/* Two squares peeking out behind the front logo. */}
      <div
        className={`absolute right-[-3px] top-[-3px] h-8 w-8 rounded-md ${peekClass}`}
        aria-hidden="true"
      />
      <div
        className={`absolute right-[-1.5px] top-[-1.5px] h-8 w-8 rounded-md ${peekClass}`}
        aria-hidden="true"
      />
      <SourceIcon
        source={source}
        url={url}
        sizeClass="h-8 w-8"
        className={`absolute inset-0 ${iconClassName}`}
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Theme switcher. A compact Light/Dark segmented control that lives
// inside the Configure Layout dialog. Self-contained so it can be dropped into
// the dialog header without threading theme state through the page component.
// Uses the Curated route's scoped ThemeProvider. This setting never reads or
// changes the main application theme.
// -----------------------------------------------------------------------------
function CuratedThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  return (
    <div
      className="inline-flex items-center rounded-md border border-border bg-background p-0.5"
      role="group"
      aria-label="Theme"
      data-testid="switcher-curated-theme"
    >
      <Button
        type="button"
        size="sm"
        variant={theme === "light" ? "default" : "ghost"}
        className={
          theme === "light"
            ? "bg-curated-accent text-white"
            : "text-muted-foreground"
        }
        onClick={() => {
          try { localStorage.setItem(CURATED_THEME_STORAGE_KEY, "light"); } catch { /* ignore */ }
          if (theme !== "light") setTheme("light");
        }}
        aria-pressed={theme === "light"}
        data-testid="button-theme-light"
      >
        <Sun className="h-4 w-4" />
        <span className="ml-1.5">Light</span>
      </Button>
      <Button
        type="button"
        size="sm"
        variant={theme === "dark" ? "default" : "ghost"}
        className={
          theme === "dark"
            ? "bg-curated-accent text-white"
            : "text-muted-foreground"
        }
        onClick={() => {
          try { localStorage.setItem(CURATED_THEME_STORAGE_KEY, "dark"); } catch { /* ignore */ }
          if (theme !== "dark") setTheme("dark");
        }}
        aria-pressed={theme === "dark"}
        data-testid="button-theme-dark"
      >
        <Moon className="h-4 w-4" />
        <span className="ml-1.5">Dark</span>
      </Button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------
export default function Curated() {
  const [location, setLocation] = useLocation();
  const { toast } = useToast();
  const { user: replitUser } = useAuth();
  const { theme, setTheme } = useTheme();
  // Used as a reactive dependency so a timezone-only change (written via the
  // setSelectedTimezone module function, not React state) still triggers a
  // server push — the hook reads localStorage at push time so no extra work.
  const tz = useTimezone();
  const { data: curatedAccess, isLoading: accessLoading } = useQuery<{
    hasCuratedAccess: boolean;
    canView?: boolean;
    canEdit?: boolean;
  }>({
    queryKey: ["/api/auth/curated-access"],
    retry: false,
  });
  // Page visibility rides `canView`: any standard app-password login grants
  // view-only ("public") access; editing is the separate tester-allowlist tier.
  // `hasCuratedAccess` is kept as a backward-compat alias of canView.
  const hasAccess = curatedAccess?.canView ?? curatedAccess?.hasCuratedAccess;
  // canEdit is true only for the tester allowlist — editors get moderation
  // controls, the hidden-stories panel, and the "view as public" toggle.
  // Regular viewers (standard app login) have canEdit === false.
  const canEdit = curatedAccess?.canEdit === true;
  // Curated View walkthrough open-state (Task #371). Declared here — ahead of the
  // editor-access gate — because the tour must render the page exactly as a public
  // (non-editor) viewer sees it: while it is open every editor affordance is
  // suppressed, and they all return the instant it is skipped or finished. The
  // auto-launch / opener wiring lives further below.
  const [tourOpen, setTourOpen] = useState(false);
  // "View as public" (Task #380 expansion) — an instant, client-only preview that
  // suppresses EVERY editor affordance so an allowlisted editor sees exactly what
  // the public sees. It NEVER relaxes the real PAGE access gate below (which still
  // keys off `hasAccess`); it only flips the rendered editor controls.
  const [previewAsPublic, setPreviewAsPublic] = useState(false);
  // Editor affordances are suppressed both by the manual "view as public" toggle
  // AND while the walkthrough is open, so the tour always shows the public view.
  const effectiveAccess = canEdit && !previewAsPublic && !tourOpen;

  // Top Stories header — client-side sort control (Task #643). Purely a local
  // reordering of the already-loaded, search-filtered set; never re-fetches and
  // never touches server-side clustering/priority ranking. Editor-only; reset
  // to default when access is lost (e.g. "view as public" preview).
  const [topStoriesSort, setTopStoriesSort] = useState<TopStoriesSortMode>("priority-desc");
  // Editor view mode (Task #834 rework) — SEPARATE state from the sort so the
  // sort pipeline stays untouched (priority-desc default stays byte-identical).
  // 'feed' renders the normal ranked list; the other modes swap the list body.
  const [editorViewMode, setEditorViewMode] = useState<EditorViewMode>("feed");
  useEffect(() => {
    if (!effectiveAccess) {
      setTopStoriesSort("priority-desc");
      setEditorViewMode("feed");
    }
  }, [effectiveAccess]);
  // Top Stories header — editor-only multi-select "select for consideration"
  // mode (Task #643). Local-only state; resets whenever the mode is toggled
  // off. Keys are `${type}:${id}` via storyKey().
  const [topStoriesSelectMode, setTopStoriesSelectMode] = useState(false);
  const [topStoriesSelectedKeys, setTopStoriesSelectedKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!topStoriesSelectMode) setTopStoriesSelectedKeys(new Set());
  }, [topStoriesSelectMode]);
  // Selection mode is an editor-only affordance; force it off (and clear any
  // selection) the instant editor access is lost, e.g. flipping "view as
  // public" or the access check resolving to false.
  useEffect(() => {
    if (!effectiveAccess) setTopStoriesSelectMode(false);
  }, [effectiveAccess]);

  // Not-logged-in visitors are NOT bounced away. The render gate near the bottom
  // of this component shows the MCOP password login in-place on /curated; after a
  // successful login the access check refetches, canView flips true, and the
  // Curated view renders without ever leaving the page.

  // Curated View feature walkthrough (Task #371). Auto-launch on a viewer's
  // FIRST open, remember it as seen so it never re-triggers, and offer a replay
  // button in the header. Auto-show is time-boxed (info phase) so it retires on
  // its own; the replay button keeps working afterward. Gated on the LIVE
  // /curated route only — the frozen background Curated rendered behind the
  // methodology overlay must not pop the tour. (`tourOpen` itself is declared
  // above, next to the editor-access gate it feeds.)
  // The intro OPENER auto-pops first (not the tour itself); it leads into the
  // walkthrough or is skipped. It auto-shows only on a genuine first visit to the
  // live /curated route while the info phase is active — gated on BOTH the
  // persistent "seen" flag and an in-memory session-suppression flag so it never
  // nags:
  //   • Taking the tour or checking "Don't show this again" → markCuratedTourSeen()
  //     (persistent): the opener never auto-shows again.
  //   • "Skip for now" (no checkbox) → session suppression only: stays down for
  //     this visit (including leaving to the Methodology page and returning), then
  //     re-appears on the next app load.
  // The header replay button re-opens the intro OPENER (welcome screen) — the
  // same starting point as a first visit — ignoring both auto-show flags; the
  // viewer then chooses "See what's new" to enter the walkthrough, or skips.
  const [openerOpen, setOpenerOpen] = useState(false);
  // Brief accent pulse on the header replay button after the opener is absorbed
  // into it, so the viewer learns where the tour lives afterward.
  const [tourButtonPulse, setTourButtonPulse] = useState(false);
  useEffect(() => {
    if (
      // Never auto-pop the opener in the dev environment: the "seen" flag lives in
      // localStorage (frequently cleared in the dev preview) and the session
      // suppression resets on every reload, so it would nag on each dev refresh.
      // The header replay button and production first-visit behavior are untouched.
      !import.meta.env.DEV &&
      hasAccess === true &&
      location === "/curated" &&
      isCuratedInfoPhaseActive() &&
      !hasSeenCuratedTour() &&
      !isCuratedOpenerSessionSuppressed()
    ) {
      setOpenerOpen(true);
    }
  }, [hasAccess, location]);

  const handleOpenerTakeTour = () => {
    // Engaging with the tour counts as seen — the opener won't auto-show again.
    markCuratedTourSeen();
    suppressCuratedOpenerForSession();
    setOpenerOpen(false);
    setTourOpen(true);
  };
  const handleOpenerSkip = (dontShowAgain: boolean) => {
    // "Don't show this again" persists the seen flag (never auto-shows again);
    // a plain "Skip for now" only suppresses the opener for this visit, so it
    // re-appears on the user's next app load.
    if (dontShowAgain) markCuratedTourSeen();
    suppressCuratedOpenerForSession();
    setOpenerOpen(false);
    setTourButtonPulse(true);
    window.setTimeout(() => setTourButtonPulse(false), 1500);
  };

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedStory, setSelectedStory] = useState<CuratedStory | null>(null);
  // Scroll offset to re-apply to the popup body after a methodology round trip.
  const [pendingStoryScroll, setPendingStoryScroll] = useState<number | null>(null);
  const [heroIndex, setHeroIndex] = useState(0);

  // Restore an open story popup after a round trip to the methodology guide.
  // The /curated/methodology route remounts a fresh Curated view, so a story
  // open when the user clicked "See more in methodology" is stashed in
  // sessionStorage and re-opened here on return to /curated. Gated on the live
  // path so the FROZEN background Curated rendered behind the methodology
  // overlay (location === "/curated/methodology") never consumes the stash —
  // otherwise the popup would never re-open on the way back.
  useEffect(() => {
    if (location !== "/curated") return;
    const raw = sessionStorage.getItem(CURATED_PENDING_STORY_KEY);
    if (!raw) return;
    sessionStorage.removeItem(CURATED_PENDING_STORY_KEY);
    try {
      const parsed = JSON.parse(raw) as
        | { story: CuratedStory; scrollTop?: number }
        | CuratedStory;
      // New stashes wrap the story with the popup scroll offset; tolerate older
      // bare-story stashes from a session that predates this.
      const story = "story" in parsed ? parsed.story : parsed;
      const scrollTop = "story" in parsed ? parsed.scrollTop ?? 0 : 0;
      setSelectedStory(story);
      setPendingStoryScroll(scrollTop);
    } catch {
      /* corrupt stash — ignore and leave the feed as-is */
    }
  }, [location]);

  // -------------------------------------------------------------------------
  // Unified "Configure Layout" state (Task #258 follow-up). A single modal
  // controls every section's visibility, item counts and column arrangement.
  // Initial values come from the saved config once on mount; one effect writes
  // the whole object back on any change. (socialLayout keeps its own key.)
  // -------------------------------------------------------------------------
  const initialLayoutRef = useRef<CuratedLayoutConfig>();
  if (!initialLayoutRef.current) initialLayoutRef.current = loadLayoutConfig();
  const c0 = initialLayoutRef.current;

  // Top bar
  const [showTicker, setShowTicker] = useState(c0.showTicker);
  const [tickerMode, setTickerMode] = useState<TickerMode>(c0.tickerMode);
  const [showLiveBanner, setShowLiveBanner] = useState(c0.showLiveBanner);
  const [showSearchBar, setShowSearchBar] = useState(c0.showSearchBar);
  const [showMcopBot, setShowMcopBot] = useState(c0.showMcopBot);
  const [mcopBotOpen, setMcopBotOpen] = useState(false);
  // Left column
  const [showMcopHighlights, setShowMcopHighlights] = useState(c0.showMcopHighlights);
  const [showIeHighlights, setShowIeHighlights] = useState(c0.showIeHighlights);
  const [showAerial, setShowAerial] = useState(c0.showAerial);
  const [showAerialDomestic, setShowAerialDomestic] = useState(c0.showAerialDomestic);
  const [aerialDomesticMax, setAerialDomesticMax] = useState(c0.aerialDomesticMax);
  const [showAerialIntl, setShowAerialIntl] = useState(c0.showAerialIntl);
  const [aerialIntlMax, setAerialIntlMax] = useState(c0.aerialIntlMax);
  const [showAerialTrending, setShowAerialTrending] = useState(c0.showAerialTrending);
  // Middle column
  const [showTopStories, setShowTopStories] = useState(c0.showTopStories);
  const [showStateNarratives, setShowStateNarratives] = useState(c0.showStateNarratives);
  // State-controlled Narratives detail view (Task #450). Holds the country whose
  // full lens is expanded in the dialog; null = closed. The dialog's left/right
  // selectors just move this pointer across the present countries.
  const [stateNarrativeDetail, setStateNarrativeDetail] = useState<string | null>(
    null,
  );
  const [showPreviewPane, setShowPreviewPane] = useState(c0.showPreviewPane);
  const [topStoriesCount, setTopStoriesCount] = useState(c0.topStoriesCount);
  const [storiesFeedCount, setStoriesFeedCount] = useState(c0.storiesFeedCount);
  // Movable feeds — each carries a column placement (left / right / off).
  const [truthPlacement, setTruthPlacement] = useState(c0.truthPlacement);
  const [secwarPlacement, setSecwarPlacement] = useState(c0.secwarPlacement);
  const [osintPlacement, setOsintPlacement] = useState(c0.osintPlacement);
  const [pressPlacement, setPressPlacement] = useState(c0.pressPlacement);
  const [customFeedPlacement, setCustomFeedPlacement] = useState(c0.customFeedPlacement);
  const [firstAlertPlacement, setFirstAlertPlacement] = useState(c0.firstAlertPlacement);
  // Derived on/off flags (a feed is "shown" when it has a column). Kept so the
  // many existing visibility checks and data-query gates read unchanged.
  const showTruth = truthPlacement !== "off";
  const showSecwar = secwarPlacement !== "off";
  const showOsint = osintPlacement !== "off";
  const showPress = pressPlacement !== "off";
  const showCustomFeed = customFeedPlacement !== "off";
  const showFirstAlert = firstAlertPlacement !== "off";
  // The unified Configure Layout modal open state.
  const [configOpen, setConfigOpen] = useState(false);
  // Feedback dialog open state.
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  // Restore every page-level layout setting to the factory defaults. The board
  // resets its own placement state; this resets the visibility/counts/placements
  // and the social-bloc column count the page owns. Both persist effects then
  // write the defaults back to their localStorage keys.
  const handleResetLayoutDefaults = () => {
    const d = LAYOUT_CONFIG_DEFAULTS;
    setShowTicker(d.showTicker);
    setTickerMode(d.tickerMode);
    setShowLiveBanner(d.showLiveBanner);
    setShowSearchBar(d.showSearchBar);
    setShowMcopBot(d.showMcopBot);
    setShowMcopHighlights(d.showMcopHighlights);
    setShowIeHighlights(d.showIeHighlights);
    setShowAerial(d.showAerial);
    setShowAerialDomestic(d.showAerialDomestic);
    setAerialDomesticMax(d.aerialDomesticMax);
    setShowAerialIntl(d.showAerialIntl);
    setAerialIntlMax(d.aerialIntlMax);
    setShowAerialTrending(d.showAerialTrending);
    setShowTopStories(d.showTopStories);
    setShowStateNarratives(d.showStateNarratives);
    setShowPreviewPane(d.showPreviewPane);
    setTopStoriesCount(d.topStoriesCount);
    setStoriesFeedCount(d.storiesFeedCount);
    setTruthPlacement(d.truthPlacement);
    setSecwarPlacement(d.secwarPlacement);
    setOsintPlacement(d.osintPlacement);
    setPressPlacement(d.pressPlacement);
    setCustomFeedPlacement(d.customFeedPlacement);
    setFirstAlertPlacement(d.firstAlertPlacement);
    setSocialLayout(3);
    // Discard any per-divider drag-resize nudges so "Reset to Default" restores
    // the standard column widths, not just the section placements/visibility.
    clearColumnWeights();
  };

  // Persist the entire layout config whenever any piece changes.
  useEffect(() => {
    try {
      const cfg: CuratedLayoutConfig = {
        showTicker,
        tickerMode,
        showLiveBanner,
        showSearchBar,
        showMcopBot,
        showMcopHighlights,
        showIeHighlights,
        showAerial,
        showAerialDomestic,
        aerialDomesticMax,
        showAerialIntl,
        aerialIntlMax,
        showAerialTrending,
        showTopStories,
        showStateNarratives,
        showPreviewPane,
        topStoriesCount,
        storiesFeedCount,
        truthPlacement,
        secwarPlacement,
        osintPlacement,
        pressPlacement,
        customFeedPlacement,
        firstAlertPlacement,
      };
      localStorage.setItem(
        LAYOUT_CONFIG_KEY,
        JSON.stringify({ ...cfg, __v: LAYOUT_CONFIG_VERSION }),
      );
    } catch {
      /* private mode / quota — config just won't persist this session */
    }
  }, [
    showTicker,
    tickerMode,
    showLiveBanner,
    showSearchBar,
    showMcopBot,
    showMcopHighlights,
    showIeHighlights,
    showAerial,
    showAerialDomestic,
    aerialDomesticMax,
    showAerialIntl,
    aerialIntlMax,
    showAerialTrending,
    showTopStories,
    showStateNarratives,
    showPreviewPane,
    topStoriesCount,
    storiesFeedCount,
    truthPlacement,
    secwarPlacement,
    osintPlacement,
    pressPlacement,
    customFeedPlacement,
    firstAlertPlacement,
  ]);

  // Curated social bloc 3 / 2 / 1 column layout (Task #252), persisted under its
  // own key. The picker now lives inside the unified Configure Layout modal.
  const [socialLayout, setSocialLayout] = useState<SocialLayout>(() => {
    try {
      const saved = localStorage.getItem(SOCIAL_LAYOUT_STORAGE_KEY);
      const n = saved ? parseInt(saved, 10) : 3;
      return n === 1 || n === 2 || n === 3 ? (n as SocialLayout) : 3;
    } catch {
      return 3;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SOCIAL_LAYOUT_STORAGE_KEY, String(socialLayout));
    } catch {
      /* private mode / quota — layout just won't persist this session */
    }
  }, [socialLayout]);

  // The Configure Layout board's R1 lanes drive the live social bloc (Task #322
  // follow-up). Re-read whenever the board persists a change (same-tab custom
  // event) or another tab edits the saved layout (native storage event).
  const [boardLayout, setBoardLayout] = useState<BoardLayout>(() =>
    loadCuratedBoardLayout(),
  );
  useEffect(() => {
    const reload = () => setBoardLayout(loadCuratedBoardLayout());
    const onStorage = (e: StorageEvent) => {
      if (e.key === BOARD_LAYOUT_KEY) reload();
    };
    window.addEventListener(CURATED_BOARD_LAYOUT_CHANGED_EVENT, reload);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CURATED_BOARD_LAYOUT_CHANGED_EVENT, reload);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  // Per-viewer column-width nudges (Task #378 follow-up). Deltas keyed by the
  // active layout's base fr weights, so each column combination remembers its
  // own slight resize. Drag the lines between columns (or arrow-key the handle).
  const { map: columnWeights, update: updateColumnWeights, clear: clearColumnWeights, setAll: setAllColumnWeights } =
    useCuratedColumnWeights();
  const mainGridRef = useRef<HTMLDivElement>(null);
  // Callback-ref + width for the right grid-cell column. The callback-ref
  // pattern ensures the ResizeObserver attaches/detaches correctly whenever
  // the right column appears or disappears (layout-mode switches, hasRightContent
  // toggling) — a plain useRef + useEffect([ref]) misses late mounts.
  const [rightColCallbackRef, rightColWidth] = useColumnWidthObserver();
  // Tracks the current "stepped-up" state across renders for hysteresis.
  const rightSteppedUpRef = useRef(false);
  // Same callback-ref + hysteresis pair for the MIDDLE (Top Stories) grid cell,
  // so its reading text steps up one notch when the viewer drags it wider — the
  // right column already does this; this brings the centre column to parity.
  const [middleColCallbackRef, middleColWidth] = useColumnWidthObserver();
  const middleSteppedUpRef = useRef(false);
  const [scrubViewerOpen, setScrubViewerOpen] = useState(false);
  // Aerial View per-bucket expand state (keyed by bucket testid). Collapsed to
  // the configured max per bucket; "See more" reveals the rest.
  const [aerialExpanded, setAerialExpanded] = useState<Record<string, boolean>>({});

  // Per-account multi-select for the U.S. X Feed (which now also carries the
  // folded-in Response feeds). Defaults to every account ON.
  // Persisted to localStorage following the same pattern as Dashboard's
  // `selectedOsintFeeds` so the choice survives reloads / return visits.
  const [selectedUsXFeed, setSelectedUsXFeed] = useState<string[]>(() =>
    loadFeedSelection(
      US_X_FEED_STORAGE_KEY,
      US_X_FEED_ACCOUNT_GROUPS,
      US_X_FEED_DEFAULT_ON,
    ),
  );
  useEffect(() => {
    localStorage.setItem(US_X_FEED_STORAGE_KEY, JSON.stringify(selectedUsXFeed));
  }, [selectedUsXFeed]);

  // Per-account multi-select for the OSINT X Feed and Press X Feed (Task #258),
  // mirroring the U.S. X Feed control above. Defaults to all accounts ON; both
  // selections persist to localStorage and respect the keep-at-least-one rule.
  const [selectedOsintFeed, setSelectedOsintFeed] = useState<string[]>(() =>
    loadFeedSelection(
      OSINT_FEED_STORAGE_KEY,
      OSINT_FEED_ACCOUNT_GROUPS,
      OSINT_FEED_DEFAULT_ON,
    ),
  );
  useEffect(() => {
    localStorage.setItem(
      OSINT_FEED_STORAGE_KEY,
      JSON.stringify(selectedOsintFeed),
    );
  }, [selectedOsintFeed]);
  const [selectedPressFeed, setSelectedPressFeed] = useState<string[]>(() =>
    loadFeedSelection(
      PRESS_FEED_STORAGE_KEY,
      PRESS_FEED_ACCOUNT_GROUPS,
      PRESS_FEED_DEFAULT_ON,
    ),
  );
  useEffect(() => {
    localStorage.setItem(
      PRESS_FEED_STORAGE_KEY,
      JSON.stringify(selectedPressFeed),
    );
  }, [selectedPressFeed]);

  // Per-X-feed "Hide reposts" display filter (Task #372). Persisted like the
  // account selections above; default ON (reposts hidden unless re-enabled). The
  // same state backs both the feed dropdown toggle and the Configure Layout
  // board's per-card toggle so the two control surfaces stay consistent.
  const [hideRepostsUsXFeed, setHideRepostsUsXFeed] = useState<boolean>(() =>
    loadBoolSetting(HIDE_REPOSTS_US_X_STORAGE_KEY, true),
  );
  useEffect(() => {
    localStorage.setItem(
      HIDE_REPOSTS_US_X_STORAGE_KEY,
      hideRepostsUsXFeed ? "true" : "false",
    );
  }, [hideRepostsUsXFeed]);
  const [hideRepostsOsintFeed, setHideRepostsOsintFeed] = useState<boolean>(() =>
    loadBoolSetting(HIDE_REPOSTS_OSINT_STORAGE_KEY, true),
  );
  useEffect(() => {
    localStorage.setItem(
      HIDE_REPOSTS_OSINT_STORAGE_KEY,
      hideRepostsOsintFeed ? "true" : "false",
    );
  }, [hideRepostsOsintFeed]);
  const [hideRepostsPressFeed, setHideRepostsPressFeed] = useState<boolean>(() =>
    loadBoolSetting(HIDE_REPOSTS_PRESS_STORAGE_KEY, true),
  );
  useEffect(() => {
    localStorage.setItem(
      HIDE_REPOSTS_PRESS_STORAGE_KEY,
      hideRepostsPressFeed ? "true" : "false",
    );
  }, [hideRepostsPressFeed]);

  // Bottom-align the TOP STORIES, OSINT X Feed, and Response Feed scroll
  // regions with the bottom of the DataMinr First Alert column. The page's
  // 3-column grid already stretches every column to the same (tallest) height
  // — anchored by the LEFT column whose last section is DataMinr — so we just
  // need each of these capped scroll areas to extend down to DataMinr's bottom
  // instead of stopping at their fixed max-height. DataMinr's bottom is fixed
  // by the LEFT column's own content and is independent of these scroll
  // heights, so measuring it and growing the others to match is stable (no
  // feedback loop). Only applied at lg+ where the columns sit side-by-side.
  const firstAlertScrollRef = useRef<HTMLElement>(null);
  const topStoriesScrollRef = useRef<HTMLDivElement>(null);
  const [feedMaxH, setFeedMaxH] = useState<{
    topStories?: number;
  }>({});

  const enabled = hasAccess === true;
  const refetchInterval = autoRefresh ? 120_000 : false;

  // Change-detection poll (Task #816). While the tab is visible and the user
  // has access, poll the tiny /api/curated/revision endpoint every ~12 s.
  // Payload is just {revision, updatedAt} — zero DB work. When the revision
  // number increases past the last value the client saw, invalidate the heavy
  // queries so every logged-in viewer picks up edits within ~12 s without a
  // manual refresh. The existing 120 s auto-refresh stays as a fallback.
  // Paused when the tab is hidden (no wasted polls on background tabs).
  const lastRevisionRef = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/curated/revision");
        if (!res.ok) return;
        const data = await res.json();
        const rev: unknown = data?.revision;
        if (typeof rev !== "number") return;
        if (lastRevisionRef.current === null) {
          // Baseline not seeded yet. It is seeded from the top-stories payload's
          // own `revision` (the sync effect below), NOT from the poll's first
          // tick — so until the feed has loaded we have nothing trustworthy to
          // compare against and must not invent our own baseline (doing so was
          // the mount race: an edit landing between the initial feed fetch and
          // the first poll would be silently skipped). Skip this tick.
          return;
        }
        if (rev > lastRevisionRef.current) {
          lastRevisionRef.current = rev;
          // An edit happened — invalidate the heavy curated feeds so every
          // viewer sees the change. The server's warm-on-write means the next
          // fetch should hit a pre-built cache, not a cold recompute.
          queryClient.invalidateQueries({ queryKey: ["/api/curated/top-stories"] });
          queryClient.invalidateQueries({ queryKey: ["/api/curated/state-narratives"] });
          queryClient.invalidateQueries({ queryKey: ["/api/curated/cluster-members"] });
        }
      } catch {
        // Best-effort; missed polls are recoverable on the next tick.
      }
    };
    const id = setInterval(poll, 12_000);
    // Run once immediately on mount so the baseline is established within
    // milliseconds rather than waiting a full 12 s — edits that happen between
    // page load and the first poll are caught by the next interval tick.
    void poll();
    // Also poll when the user switches back to this tab.
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [enabled]);

  const { data: topStoriesData, isLoading: storiesLoading, refetch: refetchStories } =
    useQuery<{ stories: CuratedStory[]; topNarratives: { domestic: NarrativeItem[]; international: NarrativeItem[] }; rankingCutoffs?: { top5: number | null; top30: number | null }; hiddenStories?: HiddenStorySummary[]; revision?: number }>({
      queryKey: ["/api/curated/top-stories", { hours: 24, limit: 100 }],
      enabled,
      refetchInterval,
      // Keep the previous payload visible while a background refetch is in flight
      // so the Top Stories panel never goes blank during the 120s auto-refresh
      // cycle. The genuine first-load skeleton still shows (no prior data to
      // keep). Client-side complement to the server-side cache pre-warm.
      placeholderData: keepPreviousData,
    });
  // Seed / track the change-detection baseline (Task #816) from the revision the
  // server stamped onto THIS payload — i.e. the revision the data on screen
  // actually reflects. Doing this (instead of letting the poll seed itself on
  // its first tick) closes the mount race: an edit landing between the initial
  // feed fetch and the first poll advances the server revision past this stamp,
  // so the very next poll detects it. Advance forward only so a refetch and the
  // poll stay in lockstep and can never move the baseline backward into a loop.
  useEffect(() => {
    const rev = topStoriesData?.revision;
    if (typeof rev !== "number") return;
    if (lastRevisionRef.current === null || rev > lastRevisionRef.current) {
      lastRevisionRef.current = rev;
    }
  }, [topStoriesData?.revision]);
  const stories = topStoriesData?.stories ?? EMPTY_STORIES;
  // Current social membership, whether attached automatically by MCOP or by an
  // editor. The active top-stories payload embeds the canonical member URLs, so
  // cards can show "already attached" without a second per-card request.
  const attachedSocialStories = useMemo(() => {
    const map = new Map<string, CuratedStory>();
    for (const story of stories) {
      if (!story.clusterId || story.sourceCount < 2) continue;
      for (const member of story.members ?? []) {
        if (!member.url || !isSocialPostIdentityUrl(member.url)) continue;
        map.set(normalizeCuratedIdentityUrl(member.url), story);
      }
    }
    return map;
  }, [stories]);
  const findAttachedStory = (identityUrl: string) => {
    const story = attachedSocialStories.get(normalizeCuratedIdentityUrl(identityUrl));
    return story
      ? { title: story.headline || story.displayTitle || story.title || "Attached story" }
      : null;
  };
  const openAttachedStory = (identityUrl: string) => {
    const story = attachedSocialStories.get(normalizeCuratedIdentityUrl(identityUrl));
    if (story) setSelectedStory(story);
  };
  // Editor HIDE overlay (Task #380) — stories currently hidden from the feed,
  // for the allowlist-gated "Hidden stories" review/un-hide panel.
  const hiddenStories = topStoriesData?.hiddenStories ?? EMPTY_HIDDEN_STORIES;
  const topNarratives = topStoriesData?.topNarratives ?? EMPTY_NARRATIVES;
  const rankingCutoffs = topStoriesData?.rankingCutoffs ?? { top5: null, top30: null };
  // Competing Coverage — the most-covered U.S. + international stories right now
  // (Google News "Most Covered" backbone), INDEPENDENT of MCOP's own scoring.
  // Real headlines with clickable links; stories absent from MCOP's feed are
  // TAGGED as blind spots (not filtered out). `buzz` is one best-effort trending
  // item (may be absent on any cycle — it is fail-silent).
  const { data: competingCoverage } = useQuery<{
    domestic: CompetingCoverageItem[];
    international: CompetingCoverageItem[];
    buzz?: CompetingCoverageItem[];
    updatedAt: number | null;
  }>({
    queryKey: ["/api/curated/competing-coverage"],
    enabled,
  });
  // State-controlled Narratives (Task #450) — adversary STATE-MEDIA content,
  // bucketed per country (Russia, China, Iran, Cuba, North Korea). Curated-lane
  // only; the server already auto-hides sparse lenses, so any country present
  // here cleared its freshness floor. Read-only contrast content.
  const { data: stateNarrativesData } = useQuery<{
    countries: StateNarrativeCountry[];
    updatedAt: number;
  }>({
    queryKey: ["/api/curated/state-narratives"],
    enabled,
    refetchInterval,
  });
  const stateNarrativeCountries =
    stateNarrativesData?.countries ?? EMPTY_STATE_NARRATIVES;
  // Outlet Registry — canonical source knowledge (logos, region, ratings). Read
  // only inside this curated-gated page; never joined by any shared feed.
  const { data: outlets = [] } = useQuery<OutletRegistry[]>({
    queryKey: ["/api/curated/outlets"],
    enabled,
  });
  const outletIndex = useMemo(() => buildOutletIndex(outlets), [outlets]);
  const regionFor = (s: CuratedStory) => focusLabel(s);

  // CUSTOM FEED — persisted multi-select metadata filters + the matching stories.
  const [customFeedDialogOpen, setCustomFeedDialogOpen] = useState(false);
  const [customFeedSel, setCustomFeedSel] = useState<CustomFeedSelection>(() =>
    loadCustomFeedSelection(),
  );
  // Saved views (named presets) — local only.
  const [customFeedViews, setCustomFeedViews] = useState<CustomFeedSavedView[]>(
    () => loadCustomFeedViews(),
  );
  // Per-facet inline search text for long option lists.
  const [customFeedSearch, setCustomFeedSearch] = useState<
    Partial<Record<CustomFeedDimKey, string>>
  >({});
  const [customFeedViewName, setCustomFeedViewName] = useState("");

  // CUSTOM FEED — personal keyword watchlist (Task #456). ADDITIVE union recall:
  // any story whose text contains one of these literal, case-insensitive
  // substrings is pulled into the custom-feed section EVEN IF curated ranking
  // never surfaced it (the server scans a broader DB pool). Persisted per-browser.
  const [customFeedKeywords, setCustomFeedKeywords] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(CUSTOM_FEED_KEYWORDS_KEY);
      const arr = saved ? JSON.parse(saved) : [];
      return Array.isArray(arr)
        ? arr.filter((k: unknown): k is string => typeof k === "string")
        : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        CUSTOM_FEED_KEYWORDS_KEY,
        JSON.stringify(customFeedKeywords),
      );
    } catch {
      /* ignore */
    }
  }, [customFeedKeywords]);
  const [customFeedKeywordInput, setCustomFeedKeywordInput] = useState("");
  const addCustomFeedKeyword = () => {
    const raw = customFeedKeywordInput.trim().toLowerCase();
    setCustomFeedKeywordInput("");
    if (raw.length < 2) return;
    setCustomFeedKeywords((prev) =>
      prev.includes(raw) || prev.length >= 25 ? prev : [...prev, raw],
    );
  };
  const removeCustomFeedKeyword = (k: string) =>
    setCustomFeedKeywords((prev) => prev.filter((x) => x !== k));
  useEffect(() => {
    try {
      localStorage.setItem(
        CUSTOM_FEED_STORAGE_KEY,
        JSON.stringify(customFeedSel),
      );
    } catch {
      /* private mode / quota — selection just won't persist this session */
    }
  }, [customFeedSel]);
  useEffect(() => {
    try {
      localStorage.setItem(
        CUSTOM_FEED_VIEWS_KEY,
        JSON.stringify(customFeedViews),
      );
    } catch {
      /* private mode / quota — views just won't persist this session */
    }
  }, [customFeedViews]);

  // -------------------------------------------------------------------------
  // Cross-device settings sync (Task #824).
  //
  // Replit-logged-in users get their Curated layout/feed/theme preferences
  // synced to the server so settings follow them across browsers and devices.
  // Password-only (non-Replit) visitors stay purely browser-local.
  //
  // On mount the hook fetches the server copy:
  //   • Server has data → applyPrefsToLocalStorage(snap) is called first,
  //     then onApply re-reads via the existing load helpers so React state
  //     immediately reflects the saved settings from another device.
  //   • Server is empty → the current localStorage is seeded up (first-login
  //     merge so existing preferences are never silently discarded).
  //
  // The push() function is debounced 3 s and snapshots ALL sync keys from
  // localStorage at push time — no missed key if multiple settings change
  // rapidly. It reads from localStorage (not React state) so it never races
  // with a React batch that hasn't flushed yet.
  // -------------------------------------------------------------------------
  const onApplyServerPrefs = useCallback(() => {
    // localStorage was already updated by applyPrefsToLocalStorage() before
    // this callback fires, so we can call the same load helpers the component
    // already uses at init time — they all read from localStorage.

    // Layout config (showTicker, ticker mode, all section visibility + placements)
    const lc = loadLayoutConfig();
    setShowTicker(lc.showTicker);
    setTickerMode(lc.tickerMode);
    setShowLiveBanner(lc.showLiveBanner);
    setShowSearchBar(lc.showSearchBar);
    setShowMcopBot(lc.showMcopBot);
    setShowMcopHighlights(lc.showMcopHighlights);
    setShowIeHighlights(lc.showIeHighlights);
    setShowAerial(lc.showAerial);
    setShowAerialDomestic(lc.showAerialDomestic);
    setAerialDomesticMax(lc.aerialDomesticMax);
    setShowAerialIntl(lc.showAerialIntl);
    setAerialIntlMax(lc.aerialIntlMax);
    setShowAerialTrending(lc.showAerialTrending);
    setShowTopStories(lc.showTopStories);
    setShowStateNarratives(lc.showStateNarratives);
    setShowPreviewPane(lc.showPreviewPane);
    setTopStoriesCount(lc.topStoriesCount);
    setStoriesFeedCount(lc.storiesFeedCount);
    setTruthPlacement(lc.truthPlacement);
    setSecwarPlacement(lc.secwarPlacement);
    setOsintPlacement(lc.osintPlacement);
    setPressPlacement(lc.pressPlacement);
    setCustomFeedPlacement(lc.customFeedPlacement);
    setFirstAlertPlacement(lc.firstAlertPlacement);

    // Board layout (R1/R2 slot assignments)
    setBoardLayout(loadCuratedBoardLayout());
    // Notify CuratedLayoutBoard that the saved layout changed (same-tab)
    window.dispatchEvent(new Event(CURATED_BOARD_LAYOUT_CHANGED_EVENT));

    // Column weights (per-divider drag-resize nudges).
    // If the key is absent (e.g. cleared by a server-side reset from another
    // device), explicitly reset in-memory state to defaults — otherwise the
    // current session keeps stale widths even though localStorage was cleared.
    try {
      const raw = localStorage.getItem("curatedColumnWeightsV1");
      if (raw) {
        const m = JSON.parse(raw);
        if (m && typeof m === "object") setAllColumnWeights(m);
        else setAllColumnWeights({});
      } else {
        setAllColumnWeights({});
      }
    } catch { setAllColumnWeights({}); }

    // Social bloc column count (3 / 2 / 1)
    try {
      const saved = localStorage.getItem(SOCIAL_LAYOUT_STORAGE_KEY);
      const n = saved ? parseInt(saved, 10) : 3;
      if (n === 1 || n === 2 || n === 3) setSocialLayout(n as SocialLayout);
    } catch { /* ignore */ }

    // X Feed account selections
    setSelectedUsXFeed(loadFeedSelection(US_X_FEED_STORAGE_KEY, US_X_FEED_ACCOUNT_GROUPS, US_X_FEED_DEFAULT_ON));
    setSelectedOsintFeed(loadFeedSelection(OSINT_FEED_STORAGE_KEY, OSINT_FEED_ACCOUNT_GROUPS, OSINT_FEED_DEFAULT_ON));
    setSelectedPressFeed(loadFeedSelection(PRESS_FEED_STORAGE_KEY, PRESS_FEED_ACCOUNT_GROUPS, PRESS_FEED_DEFAULT_ON));

    // Hide-reposts filters
    setHideRepostsUsXFeed(loadBoolSetting(HIDE_REPOSTS_US_X_STORAGE_KEY, true));
    setHideRepostsOsintFeed(loadBoolSetting(HIDE_REPOSTS_OSINT_STORAGE_KEY, true));
    setHideRepostsPressFeed(loadBoolSetting(HIDE_REPOSTS_PRESS_STORAGE_KEY, true));

    // Custom feed selection, views, keywords
    setCustomFeedSel(loadCustomFeedSelection());
    setCustomFeedViews(loadCustomFeedViews());
    try {
      const raw = localStorage.getItem(CUSTOM_FEED_KEYWORDS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) {
        setCustomFeedKeywords(arr.filter((k: unknown): k is string => typeof k === "string"));
      }
    } catch { /* ignore */ }

    // Timezone
    try {
      const tz = localStorage.getItem("mcop.curated.timezone");
      if (tz) setSelectedTimezone(tz);
    } catch { /* ignore */ }

    // Theme — the Curated View ALWAYS defaults to dark and never inherits the
    // app-wide light preference. Only a curated-SPECIFIC saved choice
    // ("mcop.curated.theme", written by the switcher) can flip it to light; with
    // nothing saved for curated, force dark regardless of the global theme.
    try {
      setTheme(resolveCuratedTheme(localStorage.getItem(CURATED_THEME_STORAGE_KEY)));
    } catch { setTheme("dark"); }
  }, [
    setShowTicker, setTickerMode, setShowLiveBanner, setShowSearchBar, setShowMcopBot,
    setShowMcopHighlights, setShowIeHighlights, setShowAerial, setShowAerialDomestic,
    setAerialDomesticMax, setShowAerialIntl, setAerialIntlMax, setShowAerialTrending,
    setShowTopStories, setShowStateNarratives, setShowPreviewPane, setTopStoriesCount,
    setStoriesFeedCount, setTruthPlacement, setSecwarPlacement, setOsintPlacement,
    setPressPlacement, setCustomFeedPlacement, setFirstAlertPlacement,
    setBoardLayout, setAllColumnWeights, setSocialLayout,
    setSelectedUsXFeed, setSelectedOsintFeed, setSelectedPressFeed,
    setHideRepostsUsXFeed, setHideRepostsOsintFeed, setHideRepostsPressFeed,
    setCustomFeedSel, setCustomFeedViews, setCustomFeedKeywords,
    setTheme,
  ]);

  const { push: pushPrefs } = useCuratedPrefsSync({
    replitUserId: replitUser?.id ?? null,
    onApply: onApplyServerPrefs,
  });

  // Push current settings to the server whenever any syncable value changes.
  // `push` debounces 3 s and reads a fresh localStorage snapshot at push time
  // so rapid sequential changes are batched into one write. The push is
  // intentionally after the existing per-key localStorage write effects so
  // localStorage is already up-to-date when the snapshot is taken.
  const pushPrefsRef = useRef(pushPrefs);
  pushPrefsRef.current = pushPrefs;
  useEffect(() => {
    pushPrefsRef.current();
  }, [
    showTicker, tickerMode, showLiveBanner, showSearchBar, showMcopBot,
    showMcopHighlights, showIeHighlights, showAerial, showAerialDomestic,
    aerialDomesticMax, showAerialIntl, aerialIntlMax, showAerialTrending,
    showTopStories, showStateNarratives, showPreviewPane, topStoriesCount,
    storiesFeedCount, truthPlacement, secwarPlacement, osintPlacement,
    pressPlacement, customFeedPlacement, firstAlertPlacement,
    boardLayout, columnWeights,
    socialLayout,
    selectedUsXFeed, selectedOsintFeed, selectedPressFeed,
    hideRepostsUsXFeed, hideRepostsOsintFeed, hideRepostsPressFeed,
    customFeedSel, customFeedViews, customFeedKeywords,
    theme,
    // tz is reactive: useTimezone() re-renders whenever setSelectedTimezone()
    // writes to localStorage, so a timezone-only change reliably triggers a push.
    tz,
  ]);

  // Precompute each loaded story's filterable metadata once.
  const customFeedMetas = useMemo(
    () =>
      stories.map((s) => ({
        story: s,
        meta: customFeedMetaForStory(s, outletIndex),
      })),
    [stories, outletIndex],
  );

  const customFeedSelCount = customFeedSelectionCount(customFeedSel);

  const customFeedStories = useMemo(() => {
    if (customFeedSelCount === 0) return [] as CuratedStory[];
    const now = Date.now();
    return customFeedMetas
      .filter(({ meta }) => storyMatchesCustomFeed(meta, customFeedSel, now))
      .map(({ story }) => story);
  }, [customFeedMetas, customFeedSel, customFeedSelCount]);

  // ADDITIVE keyword recall (Task #456) — dedicated endpoint, NEVER the cached
  // top-stories payload, and the results live ONLY in this section. The scan
  // window follows the custom-feed time facet (default 24h).
  const customFeedKeywordParam = customFeedKeywords.join(",");
  const customFeedKeywordHours = customFeedSel.timeWindowHours ?? 24;
  const { data: keywordMatchData, isLoading: keywordMatchesLoading } = useQuery<{
    stories: CuratedStory[];
  }>({
    queryKey: [
      "/api/curated/keyword-matches",
      { keywords: customFeedKeywordParam, hours: customFeedKeywordHours },
    ],
    enabled: enabled && customFeedKeywords.length > 0,
  });
  const keywordMatchStories = keywordMatchData?.stories ?? EMPTY_STORIES;

  // Total active controls (facets + time + keywords) — drives empty-state vs.
  // results gating for the whole section.
  const customFeedActiveCount = customFeedSelCount + customFeedKeywords.length;

  // Union the faceted selection with the keyword matches. Dedup by id, then by a
  // normalized URL so an article surfaced by BOTH a facet and a keyword shows
  // once; annotate the kept card with the matched keywords for its badge.
  const customFeedDisplayStories = useMemo(() => {
    if (keywordMatchStories.length === 0) return customFeedStories;
    const normUrl = (u: string) => (u || "").replace(/\/+$/, "").toLowerCase();
    const kwById = new Map(
      keywordMatchStories.map((s) => [s.id, s.matchedKeywords ?? []]),
    );
    const kwByUrl = new Map(
      keywordMatchStories.map((s) => [normUrl(s.url), s.matchedKeywords ?? []]),
    );
    const seenIds = new Set(customFeedStories.map((s) => s.id));
    const seenUrls = new Set(customFeedStories.map((s) => normUrl(s.url)));
    const annotated = customFeedStories.map((s) => {
      const mk = kwById.get(s.id) ?? kwByUrl.get(normUrl(s.url));
      return mk && mk.length ? { ...s, matchedKeywords: mk } : s;
    });
    const extras = keywordMatchStories.filter(
      (s) => !seenIds.has(s.id) && !seenUrls.has(normUrl(s.url)),
    );
    return [...annotated, ...extras];
  }, [customFeedStories, keywordMatchStories]);

  // Clear EVERYTHING in the custom feed (facets + time + keywords).
  const clearCustomFeedAll = () => {
    setCustomFeedSel(emptyCustomFeedSelection());
    setCustomFeedKeywords([]);
  };

  // Selection-aware (faceted) option counts: each option's count reflects how
  // many stories match the REST of the selection (its own dimension excluded).
  // Values that exist in the data but would yield zero given everything else are
  // kept (count 0) so the UI can dim them instead of hiding them.
  const customFeedOptions = useMemo(() => {
    const now = Date.now();
    const out = {} as Record<
      CustomFeedDimKey,
      { value: string; count: number }[]
    >;
    for (const { key } of CUSTOM_FEED_DIMENSIONS) {
      const sub = customFeedSelectionWithout(customFeedSel, key);
      const counts = new Map<string, number>();
      // Seed every value that occurs anywhere so dead-ends still render dimmed.
      for (const { meta } of customFeedMetas) {
        const raw = meta[key];
        const vals = Array.isArray(raw) ? raw : raw ? [raw] : [];
        for (const v of vals) if (!counts.has(v)) counts.set(v, 0);
      }
      // Also seed the full controlled vocabulary for bounded facets (Topic,
      // Region Covered, Country Covered) so values with NO active story right
      // now still appear at count 0 — a user can pick one to watch for it.
      for (const v of CUSTOM_FEED_VOCAB[key] ?? [])
        if (!counts.has(v)) counts.set(v, 0);
      for (const { meta } of customFeedMetas) {
        if (!storyMatchesCustomFeed(meta, sub, now)) continue;
        const raw = meta[key];
        const vals = Array.isArray(raw) ? raw : raw ? [raw] : [];
        for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      out[key] = Array.from(counts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    }
    return out;
  }, [customFeedMetas, customFeedSel]);

  // Time window option counts: stories matching every facet (ignoring the time
  // window itself) that also fall within each recency bucket.
  const customFeedTimeOptions = useMemo(() => {
    const now = Date.now();
    const base: CustomFeedSelection = {
      facets: customFeedSel.facets,
      timeWindowHours: null,
    };
    return CUSTOM_FEED_TIME_WINDOWS.map((opt) => {
      let count = 0;
      for (const { meta } of customFeedMetas) {
        if (!storyMatchesCustomFeed(meta, base, now)) continue;
        if (opt.hours == null) {
          count++;
        } else if (
          meta.publishedMs != null &&
          meta.publishedMs >= now - opt.hours * 3600_000
        ) {
          count++;
        }
      }
      return { ...opt, count };
    });
  }, [customFeedMetas, customFeedSel.facets]);

  // Tri-state cycle for a facet value: off → include → exclude → off.
  const cycleCustomFeed = (key: CustomFeedDimKey, value: string) => {
    setCustomFeedSel((prev) => {
      const facets = { ...prev.facets };
      const sel = facets[key] ?? { include: [], exclude: [] };
      const inInc = sel.include.includes(value);
      const inExc = sel.exclude.includes(value);
      let include = sel.include;
      let exclude = sel.exclude;
      if (!inInc && !inExc) {
        include = [...include, value];
      } else if (inInc) {
        include = include.filter((v) => v !== value);
        exclude = [...exclude, value];
      } else {
        exclude = exclude.filter((v) => v !== value);
      }
      if (include.length === 0 && exclude.length === 0) delete facets[key];
      else facets[key] = { include, exclude };
      return { ...prev, facets };
    });
  };

  // Clear a single value (from include or exclude) — used by the summary chips.
  const clearCustomFeedValue = (key: CustomFeedDimKey, value: string) => {
    setCustomFeedSel((prev) => {
      const sel = prev.facets[key];
      if (!sel) return prev;
      const facets = { ...prev.facets };
      const include = sel.include.filter((v) => v !== value);
      const exclude = sel.exclude.filter((v) => v !== value);
      if (include.length === 0 && exclude.length === 0) delete facets[key];
      else facets[key] = { include, exclude };
      return { ...prev, facets };
    });
  };

  const setCustomFeedTimeWindow = (hours: number | null) => {
    setCustomFeedSel((prev) => ({ ...prev, timeWindowHours: hours }));
  };

  // Saved-view operations (local only).
  const saveCustomFeedView = () => {
    const name = customFeedViewName.trim();
    if (!name || customFeedSelCount === 0) return;
    const view: CustomFeedSavedView = {
      id: `view-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      selection: JSON.parse(JSON.stringify(customFeedSel)),
    };
    setCustomFeedViews((prev) => [...prev, view]);
    setCustomFeedViewName("");
  };
  const applyCustomFeedView = (view: CustomFeedSavedView) => {
    setCustomFeedSel(coerceCustomFeedSelection(view.selection));
  };
  const renameCustomFeedView = (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCustomFeedViews((prev) =>
      prev.map((v) => (v.id === id ? { ...v, name: trimmed } : v)),
    );
  };
  const deleteCustomFeedView = (id: string) => {
    setCustomFeedViews((prev) => prev.filter((v) => v.id !== id));
  };
  const { data: truthPosts = [], refetch: refetchTruth } = useQuery<TruthSocialPost[]>({
    queryKey: ["/api/curated/truth-social-posts"],
    enabled,
    refetchInterval,
  });
  const { data: xPosts = [], refetch: refetchX } = useQuery<XPost[]>({
    queryKey: ["/api/curated/x-posts"],
    enabled,
    refetchInterval,
  });
  const { data: combinedOsint = [], refetch: refetchOsint } = useQuery<OsintPost[]>({
    queryKey: ["/api/curated/osint-posts"],
    enabled,
    refetchInterval,
  });
  // Journalists X Feed (Task #182) — curated-lane-only, shares the far-right
  // rotating slot with the OSINT X Feed.
  const { data: journalistPosts = [] } = useQuery<OsintPost[]>({
    queryKey: ["/api/curated/journalist-posts"],
    enabled,
    refetchInterval,
  });
  // Loaded unconditionally (when access is granted): the Response feeds are now
  // folded into the U.S. X Feed; the per-account checkbox decides which posts
  // render once they are merged in.
  const { data: responseFeed } = useQuery<{
    rapidResponsePosts: RapidResponsePost[];
    dowResponsePosts: DOWResponsePost[];
  }>({
    queryKey: ["/api/curated/response-feed"],
    enabled,
    refetchInterval,
  });
  const rapidResponsePosts = responseFeed?.rapidResponsePosts ?? [];
  const dowResponsePosts = responseFeed?.dowResponsePosts ?? [];
  // Response posts (Rapid Response 47 + DOW Rapid Response) normalized into the
  // XPost shape so they can be merged into the U.S. X Feed list.
  // @RapidResponse47 is a high-volume political account, so it gets the same
  // AI-free defense/security keyword relevance gate (hasSecurityContext) that
  // the main scrape pipeline uses — only posts that touch a security context
  // are folded into the curated U.S. X Feed. DOW Rapid Response is not gated.
  const responseFeedPosts = useMemo(() => {
    return [
      ...rapidResponsePosts
        .filter((p) => hasSecurityContext(p.content ?? ""))
        .map((p) => ({
        id: p.id, postId: p.postId, content: p.content, postedAt: p.postedAt,
        xUrl: p.xUrl, imageUrl: p.imageUrl ?? null, sourceAccount: "RapidResponse47", isRetweet: p.isRetweet ?? false, retweetedFrom: p.retweetedFrom ?? null,
      })),
      ...dowResponsePosts.map((p) => ({
        id: p.id, postId: p.postId, content: p.content, postedAt: p.postedAt,
        xUrl: p.xUrl, imageUrl: p.imageUrl ?? null, sourceAccount: "DOWResponse", isRetweet: p.isRetweet ?? false, retweetedFrom: p.retweetedFrom ?? null,
      })),
    ].sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime());
  }, [rapidResponsePosts, dowResponsePosts]);

  // U.S. X Feed = official curated X posts + the folded-in Response posts,
  // sorted by recency. Per-account selection then decides which render. Accounts
  // not covered by a multi-select group always show; every grouped account
  // (including @RapidResponse47) is shown only when its checkbox is selected.
  const usXFeedSelectedSet = useMemo(
    () => new Set(selectedUsXFeed),
    [selectedUsXFeed],
  );
  const usXFeedMerged = useMemo(() => {
    return [...(xPosts as any[]), ...responseFeedPosts].sort(
      (a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime(),
    );
  }, [xPosts, responseFeedPosts]);
  const usXFeedPosts = useMemo(() => {
    return usXFeedMerged.filter((p: any) => {
      // Repost display filter (Task #372): drop reposts when the toggle is on.
      if (hideRepostsUsXFeed && p.isRetweet) return false;
      const groupId = US_X_FEED_HANDLE_TO_GROUP[p.sourceAccount];
      // Account not part of any toggle group → always show.
      if (!groupId) return true;
      // The checkbox is authoritative: checked = visible, unchecked = hidden.
      return usXFeedSelectedSet.has(groupId);
    });
  }, [usXFeedMerged, usXFeedSelectedSet, hideRepostsUsXFeed]);

  // Per-account display filters for the OSINT X Feed and Press X Feed (Task
  // #258). Posts whose sourceAccount is not one of the feed's listed accounts
  // always render (the selector only gates the accounts it explicitly lists);
  // sentdefender_posts rows carry no sourceAccount, so they key as 'sentdefender'.
  const osintSelectedSet = useMemo(
    () => new Set(selectedOsintFeed),
    [selectedOsintFeed],
  );
  const osintFeedPosts = useMemo(() => {
    return (combinedOsint as any[]).filter((p) => {
      if (hideRepostsOsintFeed && p.isRetweet) return false;
      const acctKey = p.sourceAccount || "sentdefender";
      if (!OSINT_FEED_GROUP_IDS.has(acctKey)) return true;
      return osintSelectedSet.has(acctKey);
    });
  }, [combinedOsint, osintSelectedSet, hideRepostsOsintFeed]);
  const pressSelectedSet = useMemo(
    () => new Set(selectedPressFeed),
    [selectedPressFeed],
  );
  const pressFeedPosts = useMemo(() => {
    return (journalistPosts as any[]).filter((p) => {
      if (hideRepostsPressFeed && p.isRetweet) return false;
      const acctKey = p.sourceAccount || "sentdefender";
      if (!PRESS_FEED_GROUP_IDS.has(acctKey)) return true;
      return pressSelectedSet.has(acctKey);
    });
  }, [journalistPosts, pressSelectedSet, hideRepostsPressFeed]);

  const { data: firstAlerts = [] } = useQuery<FirstAlert[]>({
    queryKey: ["/api/curated/first-alerts"],
    enabled: enabled && showFirstAlert,
    refetchInterval,
  });
  const { data: latestScrub } = useQuery<{
    id: string;
    caoDate: string;
    filename: string;
    hasHtml: boolean;
  }>({
    queryKey: ["/api/curated/news-scrub/latest"],
    enabled,
    refetchInterval,
    retry: false,
  });
  const { data: ieHighlights, isLoading: ieHighlightsLoading } = useQuery<{
    id: string;
    caoDate: string;
    filename: string;
    groups: { group: string; trending: string[]; breaking: string[] }[];
  }>({
    queryKey: ["/api/curated/news-scrub/ie-highlights"],
    enabled,
    refetchInterval,
    retry: false,
  });
  const { data: scrubHtmlData, isLoading: scrubHtmlLoading } = useQuery<{
    htmlContent: string;
  }>({
    queryKey: ["/api/curated/news-scrub", latestScrub?.id, "html"],
    queryFn: async () => {
      const res = await fetch(`/api/curated/news-scrub/${latestScrub!.id}/html`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("No HTML available");
      return res.json();
    },
    enabled: scrubViewerOpen && !!latestScrub?.id && !!latestScrub?.hasHtml,
    retry: false,
  });

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([
        refetchStories(),
        refetchTruth(),
        refetchX(),
        refetchOsint(),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  };

  // Combined searchable text per story (Task #627). Built once per story list
  // change (not per keystroke) so typing stays responsive on the full loaded
  // list. Pulls in every field a user might remember a story by: content
  // (title/summary/bullets/lede/facts/claims), every outlet in the cluster
  // (not just the lead), and metadata (topic/category/region/country/
  // conflict track/watched keywords). Guards every optional field.
  const storySearchText = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of stories) {
      // Delegates to the module-level buildStorySearchText — shared with the
      // link/merge dialog so both searches always match on the same fields.
      map.set(s.id, buildStorySearchText(s));
    }
    return map;
  }, [stories]);

  // Manual curated re-cluster (Task #430). Kicks off a single curated clustering
  // pass on demand and refetches the Top Stories view when it returns. The pass
  // can take ~1-3 minutes and may hit transient AI rate limits internally, so the
  // mutation stays pending (button disabled/spinning) for the full duration and
  // settles cleanly on success / already-running / failure. CURATED-LANE ONLY.
  const reclusterMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/curated/recluster");
      return (await res.json()) as { ok?: boolean; stories?: number; members?: number };
    },
    onSuccess: async (data) => {
      await refetchStories();
      toast({
        title: "Re-clustering complete",
        description: `${data.stories ?? 0} ${
          (data.stories ?? 0) === 1 ? "story" : "stories"
        } · ${data.members ?? 0} ${
          (data.members ?? 0) === 1 ? "source" : "sources"
        } grouped.`,
      });
    },
    onError: (err: any) => {
      // The endpoint returns 409 when a pass (cron or a prior click) is already
      // in flight — surface that as a friendly "try again shortly" rather than a
      // hard error. apiRequest throws "<status>: <body>" on a non-2xx response.
      const msg = String(err?.message ?? "");
      if (msg.startsWith("409")) {
        toast({
          title: "A clustering pass is already running",
          description: "Please try again in a moment.",
        });
        return;
      }
      toast({ title: "Re-cluster failed", variant: "destructive" });
    },
  });

  const filteredStories = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return stories;
    const terms = q.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return stories;
    return stories.filter((s) => {
      const text = storySearchText.get(s.id) ?? "";
      return terms.every((term) => text.includes(term));
    });
  }, [stories, search, storySearchText]);

  // Preview pane (hero carousel) features the top N stories, configurable via the
  // Configure Layout modal. When the preview pane is hidden there is no carousel.
  // The hero lead ALWAYS stays anchored to the relevance/priority blend order
  // (Task #643) — it never reorders when the Top Stories sort control changes.
  const heroStories = showPreviewPane
    ? filteredStories.slice(0, topStoriesCount)
    : [];
  const heroCount = heroStories.length;
  // Static Top Stories list: ordered strictly by priority score (highest first)
  // by default, capped at the configured Stories Feed count. When the preview
  // pane is shown the single highest item is skipped (the carousel already
  // features the lead); when it's hidden the list starts from the very top.
  // The container scrolls internally. Task #643 adds a client-side sort control
  // — "Priority: High → Low" reproduces this exact default ordering byte-for-byte; every
  // other option re-sorts the same already-loaded set, never re-fetches.
  const relevanceSorted = useMemo(
    () =>
      [...filteredStories].sort(
        (a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0),
      ),
    [filteredStories],
  );
  const sortedStories = useMemo(() => {
    switch (topStoriesSort) {
      case "priority-asc":
        return [...filteredStories].sort(
          (a, b) => (a.priorityScore ?? 0) - (b.priorityScore ?? 0),
        );
      case "newest": {
        const time = (s: CuratedStory) =>
          new Date(s.articlePublishedAt || s.scrapedAt).getTime() || 0;
        return [...filteredStories].sort((a, b) => time(b) - time(a));
      }
      case "oldest": {
        const time = (s: CuratedStory) =>
          new Date(s.articlePublishedAt || s.scrapedAt).getTime() || 0;
        return [...filteredStories].sort((a, b) => time(a) - time(b));
      }
      case "topic": {
        const label = (s: CuratedStory) => storyTopicLabel(s);
        return [...filteredStories].sort((a, b) => {
          const la = label(a);
          const lb = label(b);
          if (la !== lb) return la.localeCompare(lb);
          return (b.priorityScore ?? 0) - (a.priorityScore ?? 0);
        });
      }
      case "priority-desc":
      default:
        return relevanceSorted;
    }
  }, [filteredStories, topStoriesSort, relevanceSorted]);
  // The feed IS the complete feed: the hero spotlight carousel is a highlight
  // layer ON TOP of the list, never a subtraction from it. Every story — including
  // the top-ranked item that leads the carousel — stays in the ranked list below
  // in its natural sort position, so the list is never missing a card (a lone
  // top-priority single-source story would otherwise vanish entirely). The other
  // carousel items already appear in the list, so removing only the lead was an
  // inconsistent special-case; nothing is excluded now.
  // Formed clusters (>1 source) fed to the "Attach candidates" editor view as
  // link targets. Derived from the already-loaded relevance list — zero fetch.
  const formedClusterStories = useMemo(
    () => relevanceSorted.filter((s) => (s.sourceCount ?? 1) > 1),
    [relevanceSorted],
  );
  const rankedStories = useMemo(() => {
    // Non-editors cannot select 100; clamp so a stored value of 100 never
    // silently expands the feed for a viewer who lacks editor access.
    const effectiveCount = effectiveAccess ? storiesFeedCount : Math.min(storiesFeedCount, 50);
    return sortedStories.slice(0, effectiveCount);
  }, [sortedStories, storiesFeedCount, effectiveAccess]);

  // Auto-advance the Top Stories hero carousel.
  useEffect(() => {
    if (heroCount <= 1) return;
    const t = setInterval(() => {
      setHeroIndex((i) => (i + 1) % heroCount);
    }, 13000);
    return () => clearInterval(t);
  }, [heroCount]);

  // Top Narratives: real US-domestic vs. international split (top 3 each) by
  // outlet class + individual priority, computed server-side.
  const domesticNarratives = topNarratives.domestic;
  const intlNarratives = topNarratives.international;

  // Measure DataMinr's bottom and stretch the three capped feed scrolls to it.
  // See the ref declarations above for why this is stable. Runs after paint and
  // whenever feed content, visibility, or the viewport changes.
  useLayoutEffect(() => {
    let raf = 0;
    const recompute = () => {
      const lgUp = window.matchMedia("(min-width: 1024px)").matches;
      const fa = firstAlertScrollRef.current;
      const next: { topStories?: number } = {};
      if (lgUp && fa) {
        const target = fa.getBoundingClientRect().bottom;
        const MIN = 240;
        const fit = (el: HTMLDivElement | null) =>
          el
            ? Math.max(Math.round(target - el.getBoundingClientRect().top), MIN)
            : undefined;
        next.topStories = fit(topStoriesScrollRef.current);
      }
      setFeedMaxH((prev) =>
        prev.topStories === next.topStories ? prev : next,
      );
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recompute);
    };
    schedule();
    window.addEventListener("resize", schedule);
    const ro = new ResizeObserver(schedule);
    const grid = firstAlertScrollRef.current?.closest(".grid");
    if (grid) ro.observe(grid);
    if (firstAlertScrollRef.current) ro.observe(firstAlertScrollRef.current);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      ro.disconnect();
    };
  }, [
    storiesLoading,
    rankedStories.length,
    heroCount,
    firstAlerts.length,
    truthPosts.length,
    usXFeedPosts.length,
    combinedOsint.length,
    domesticNarratives.length,
    intlNarratives.length,
    ieHighlights,
    showFirstAlert,
    showTopStories,
    showOsint,
    showPress,
    showTruth,
    showSecwar,
  ]);

  // Open a narrative's detail. Prefer the full story already loaded in `stories`
  // (clustered → its cluster row, with synthesized lede/facts; standalone → its
  // own row), so detail renders exactly as it does from the middle column. Fall
  // back to a minimal story object when no matching row is loaded.
  const openNarrative = (n: NarrativeItem) => {
    const normalize = (u: string) => (u || "").trim().replace(/\/+$/, "").toLowerCase();
    const full = n.clusterId
      ? stories.find((s) => s.clusterId === n.clusterId)
      : stories.find((s) => s.id === n.id || normalize(s.url) === normalize(n.url));
    if (full) {
      setSelectedStory(full);
      return;
    }
    setSelectedStory({
      id: n.id,
      type: n.type,
      title: n.title,
      summary: n.summary ?? "",
      summaryBullets: n.summaryBullets ?? null,
      ogImageUrl: null,
      videoUrl: null,
      category: n.category || "General",
      region: n.region ?? null,
      country: n.country ?? null,
      // Controlled-vocab overlay → the detail's Topic·Focus matches the rest of
      // the curated view ("Force Posture · Israel"), not the free-form category.
      primaryTopic: n.primaryTopic ?? null,
      conflictTrack: n.conflictTrack ?? null,
      countryPair: n.countryPair ?? null,
      source: n.source,
      url: n.url,
      clusterId: n.clusterId,
      priorityScore: n.priorityScore,
      scrapedAt: n.scrapedAt,
      articlePublishedAt: n.articlePublishedAt,
      sourceCount: n.sourceCount,
      role: "contributing",
      lede: null,
      facts: null,
      linkDead: n.linkDead ?? false,
    });
  };

  const usXFeedDropdown = (
    <FeedAccountSelector
      title="U.S. X Feed Accounts"
      ariaLabel="Choose U.S. X Feed accounts"
      testIdButton="button-us-x-feed-accounts"
      testIdPrefix="toggle-us-x-feed"
      groups={US_X_FEED_ACCOUNT_GROUPS}
      selected={selectedUsXFeed}
      setSelected={setSelectedUsXFeed}
      hideReposts={hideRepostsUsXFeed}
      setHideReposts={setHideRepostsUsXFeed}
      hideRepostsTestId="toggle-us-x-feed-hide-reposts"
    />
  );
  const osintFeedDropdown = (
    <FeedAccountSelector
      title="OSINT X Feed Accounts"
      ariaLabel="Choose OSINT X Feed accounts"
      testIdButton="button-osint-x-feed-accounts"
      testIdPrefix="toggle-osint-x-feed"
      groups={OSINT_FEED_ACCOUNT_GROUPS}
      selected={selectedOsintFeed}
      setSelected={setSelectedOsintFeed}
      hideReposts={hideRepostsOsintFeed}
      setHideReposts={setHideRepostsOsintFeed}
      hideRepostsTestId="toggle-osint-x-feed-hide-reposts"
    />
  );
  const pressFeedDropdown = (
    <FeedAccountSelector
      title="Press X Feed Accounts"
      ariaLabel="Choose Press X Feed accounts"
      testIdButton="button-press-x-feed-accounts"
      testIdPrefix="toggle-press-x-feed"
      groups={PRESS_FEED_ACCOUNT_GROUPS}
      selected={selectedPressFeed}
      setSelected={setSelectedPressFeed}
      hideReposts={hideRepostsPressFeed}
      setHideReposts={setHideRepostsPressFeed}
      hideRepostsTestId="toggle-press-x-feed-hide-reposts"
    />
  );

  // -------------------------------------------------------------------------
  // Movable-feed rendering (Task #275). Each of the six movable feeds can land
  // in the left or right column. The feed bodies are defined once here as
  // scale-parametrised nodes so the same content renders in whichever column
  // the viewer placed it. Social feeds shrink to "sm" in the narrower left
  // column; on the right they keep the 3/2/1 layout's scale.
  // -------------------------------------------------------------------------
  const movableFeedPlacements: Record<MovableFeedKey, FeedPlacement> = {
    truth: truthPlacement,
    secwar: secwarPlacement,
    osint: osintPlacement,
    press: pressPlacement,
    customFeed: customFeedPlacement,
    firstAlert: firstAlertPlacement,
  };

  // The six movable feeds, in display order, with the label + state plumbing the
  // Configure Layout dialog needs to render a placement checkbox in BOTH columns.
  const movableFeedDefs: {
    key: MovableFeedKey;
    label: string;
    placement: FeedPlacement;
    setPlacement: (p: FeedPlacement) => void;
    testidBase: string;
    defaultColumn: "left" | "right";
  }[] = [
    { key: "truth", label: "POTUS Truth Social", placement: truthPlacement, setPlacement: setTruthPlacement, testidBase: "truth", defaultColumn: "right" },
    { key: "secwar", label: "U.S. X Feed", placement: secwarPlacement, setPlacement: setSecwarPlacement, testidBase: "secwar", defaultColumn: "right" },
    { key: "osint", label: "OSINT X Feed", placement: osintPlacement, setPlacement: setOsintPlacement, testidBase: "osint", defaultColumn: "right" },
    { key: "press", label: "Press X Feed", placement: pressPlacement, setPlacement: setPressPlacement, testidBase: "press", defaultColumn: "right" },
    { key: "customFeed", label: "Custom Feed", placement: customFeedPlacement, setPlacement: setCustomFeedPlacement, testidBase: "custom-feed", defaultColumn: "right" },
    { key: "firstAlert", label: "DATAMINR", placement: firstAlertPlacement, setPlacement: setFirstAlertPlacement, testidBase: "first-alert", defaultColumn: "left" },
  ];

  // R1 columns honor exactly `socialLayout` lanes from the saved board layout.
  // Every other slot's POSITION is now read from the board too (see
  // renderColumnSlots); a feed's column is wherever the board placed it, and
  // de-dup in normalizeBoard guarantees it lives in exactly one slot, so the old
  // r1Owned / left-right standalone bookkeeping is no longer needed.
  const r1Lanes = selectR1Lanes(boardLayout, socialLayout);

  const renderTruthNode = (scale: CuratedFeedScale) => (
    <TruthSocialFeed
      posts={truthPosts}
      filterJunkImages
      variant="curated"
      scale={scale}
      canAttachSocialPosts={effectiveAccess}
      findAttachedStory={findAttachedStory}
      onOpenAttachedStory={openAttachedStory}
    />
  );
  const renderUsXNode = (scale: CuratedFeedScale) => (
    <XPostsFeed
      posts={usXFeedPosts as any}
      avatarMap={US_X_FEED_ALL_AVATARS}
      nameMap={US_X_FEED_NAMES}
      initialsMap={US_X_FEED_INITIALS}
      variant="curated"
      scale={scale}
      canAttachSocialPosts={effectiveAccess}
      findAttachedStory={findAttachedStory}
      onOpenAttachedStory={openAttachedStory}
    />
  );
  const renderOsintNode = (scale: CuratedFeedScale) => (
    <SentDefenderFeed
      posts={osintFeedPosts.slice(0, 12) as any}
      avatarMap={OSINT_FEED_AVATARS}
      nameMap={OSINT_FEED_NAMES}
      variant="curated"
      scale={scale}
      canAttachSocialPosts={effectiveAccess}
      findAttachedStory={findAttachedStory}
      onOpenAttachedStory={openAttachedStory}
    />
  );
  const renderPressNode = (scale: CuratedFeedScale) => (
    <SentDefenderFeed
      posts={pressFeedPosts.slice(0, 12) as any}
      avatarMap={JOURNALIST_FEED_AVATARS}
      nameMap={JOURNALIST_FEED_NAMES}
      variant="curated"
      emptyLabel="No Press posts available"
      scale={scale}
      canAttachSocialPosts={effectiveAccess}
      findAttachedStory={findAttachedStory}
      onOpenAttachedStory={openAttachedStory}
    />
  );

  // A movable social feed rendered as a standalone left-column section (used
  // only when the feed's placement is "left"; the right column keeps its own
  // 3/2/1 bloc layout below).
  const renderLeftSocialSection = (
    testid: string,
    title: string,
    node: React.ReactNode,
    headerControl?: React.ReactNode,
    tooltip?: React.ReactNode,
  ) => (
    <section data-testid={testid}>
      <SectionHeading title={title} tooltip={tooltip} actions={headerControl} />
      <div className="curated-scroll overflow-y-auto overflow-x-hidden max-h-[480px] pr-2">
        {node}
      </div>
    </section>
  );

  // DataMinr First Alert section. Carries firstAlertScrollRef wherever it lands
  // so the height-sync that anchors the capped feeds to its bottom keeps working
  // when it's in the left column (its default placement).
  const renderFirstAlertSection = () => (
    <section ref={firstAlertScrollRef} data-testid="section-first-alert">
      <SectionHeading
        title="DATAMINR"
        tooltip={
          <SectionMethodologyTooltip
            section="dataminr"
            testId="tooltip-section-dataminr-standalone-methodology"
          >
            DataMinr First Alert — an AI-powered early-warning service that
            surfaces breaking events from open data, often before traditional
            news outlets publish. Shown as attached context; never forms or
            alters corroborated stories.
          </SectionMethodologyTooltip>
        }
      />
      <FirstAlertFeed alerts={firstAlerts} variant="curated" />
    </section>
  );

  // Node-only DATAMINR feed (no heading / no firstAlertScrollRef) for when it
  // rides inside the R1 social bloc as a rotating pane. The standalone left/right
  // section keeps the ref for the capped-feed height-sync, which simply no-ops
  // when DATAMINR lives in R1 instead.
  const renderFirstAlertNode = () => (
    <FirstAlertFeed alerts={firstAlerts} variant="curated" scroll={false} />
  );

  // The build-your-own Custom Feed section. A top border separates it from
  // whatever sits above it in either column.
  const renderCustomFeedSection = () => (
    <section
      className="border-t border-border pt-3 mt-3"
      data-testid="section-custom-feed"
    >
      <SectionHeading
        title="Custom Feed"
        tooltip={
          <SectionMethodologyTooltip
            section="custom-feed"
            testId="tooltip-section-custom-feed-methodology"
          >
            Build your own filtered view of the same curated stories — by topic,
            region or country, time window, source type, and keywords. It only
            filters what's already here; it doesn't change ranking or any other
            section. Signed in with Replit, your saved views and settings sync
            across devices.
          </SectionMethodologyTooltip>
        }
        actions={
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setCustomFeedDialogOpen(true)}
            data-testid="button-open-custom-feed"
            title="What do you want to see?"
          >
            <Plus className="w-4 h-4" />
          </Button>
        }
      />

      {/* Active selections summary — each chip removes its own value.
          Excluded values are styled distinctly (minus + strikethrough);
          keyword chips are styled distinctly (search icon). */}
      {customFeedActiveCount > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          {customFeedSel.timeWindowHours != null && (
            <Badge
              variant="secondary"
              className="cursor-pointer gap-1"
              onClick={() => setCustomFeedTimeWindow(null)}
              data-testid="chip-custom-feed-time"
            >
              <Clock className="w-3 h-3" />
              {CUSTOM_FEED_TIME_WINDOWS.find(
                (w) => w.hours === customFeedSel.timeWindowHours,
              )?.label ?? "Recent"}
              <X className="w-3 h-3" />
            </Badge>
          )}
          {CUSTOM_FEED_DIMENSIONS.flatMap(({ key }) => {
            const sel = customFeedSel.facets[key];
            if (!sel) return [];
            return [
              ...sel.include.map((value) => (
                <Badge
                  key={`inc-${key}-${value}`}
                  variant="secondary"
                  className="cursor-pointer gap-1"
                  onClick={() => clearCustomFeedValue(key, value)}
                  data-testid={`chip-custom-feed-${key}-${value}`}
                >
                  {value}
                  <X className="w-3 h-3" />
                </Badge>
              )),
              ...sel.exclude.map((value) => (
                <Badge
                  key={`exc-${key}-${value}`}
                  variant="outline"
                  className="cursor-pointer gap-1 border-destructive text-destructive line-through"
                  onClick={() => clearCustomFeedValue(key, value)}
                  data-testid={`chip-custom-feed-exclude-${key}-${value}`}
                >
                  <Minus className="w-3 h-3 no-underline" />
                  {value}
                  <X className="w-3 h-3" />
                </Badge>
              )),
            ];
          })}
          {customFeedKeywords.map((k) => (
            <Badge
              key={`kw-${k}`}
              variant="secondary"
              className="cursor-pointer gap-1"
              onClick={() => removeCustomFeedKeyword(k)}
              data-testid={`chip-custom-feed-keyword-${k}`}
            >
              <Search className="w-3 h-3" />
              {k}
              <X className="w-3 h-3" />
            </Badge>
          ))}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={clearCustomFeedAll}
            data-testid="button-clear-custom-feed"
          >
            Clear all
          </Button>
        </div>
      )}

      {/* Horizontal card-view feed of the user's selections. */}
      {customFeedActiveCount === 0 ? (
        <button
          type="button"
          onClick={() => setCustomFeedDialogOpen(true)}
          className="w-full border border-dashed border-border rounded-md p-6 text-center text-sm text-muted-foreground hover-elevate"
          data-testid="empty-custom-feed"
        >
          <SlidersHorizontal className="w-5 h-5 mx-auto mb-2 opacity-60" />
          Build your own feed — tap{" "}
          <Plus className="inline w-3.5 h-3.5 align-text-bottom" /> to choose
          what you want to see.
        </button>
      ) : (storiesLoading || keywordMatchesLoading) &&
        customFeedDisplayStories.length === 0 ? (
        <div
          className="flex gap-3 overflow-hidden pb-2"
          data-testid="loading-custom-feed"
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="shrink-0 w-56 border border-border rounded-md overflow-hidden"
            >
              <div className="aspect-video bg-muted animate-pulse" />
              <div className="p-2.5 space-y-2">
                <div className="h-3 w-20 rounded-sm bg-muted animate-pulse" />
                <div className="h-4 w-full rounded-sm bg-muted animate-pulse" />
                <div className="h-3 w-2/3 rounded-sm bg-muted animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : customFeedDisplayStories.length === 0 ? (
        <div
          className="border border-border rounded-md p-6 text-center text-sm text-muted-foreground"
          data-testid="empty-custom-feed-no-match"
        >
          No current stories match your selections.
        </div>
      ) : (
        <div
          className="curated-scroll flex gap-3 overflow-x-auto overflow-y-hidden pb-2"
          data-testid="list-custom-feed"
        >
          {customFeedDisplayStories.map((s) => {
            const cardImage = resolveArticleImage(
              s.ogImageUrl || (s.memberImages && s.memberImages[0]) || null,
              s.sourceCount <= 1,
              s.source,
            );
            const reg = focusLabel(s);
            return (
              <button
                type="button"
                key={s.id}
                onClick={() => setSelectedStory(s)}
                className="shrink-0 w-56 text-left border border-border rounded-md overflow-hidden hover-elevate"
                data-testid={`card-custom-feed-${s.id}`}
              >
                {cardImage && (
                  <div className="aspect-video bg-muted overflow-hidden">
                    <img
                      src={cardImage}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  </div>
                )}
                <div className="p-2.5">
                  <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
                    {s.category && (
                      <Badge variant="outline" className="text-[10px]">
                        {storyTopicLabel(s)}
                      </Badge>
                    )}
                    <span className="text-[11px] text-muted-foreground">
                      {reg.label}
                    </span>
                  </div>
                  {/* Keyword-watchlist hit badge(s) — only when this card was
                      surfaced/annotated by a watched keyword (Task #456). */}
                  {s.matchedKeywords && s.matchedKeywords.length > 0 && (
                    <div
                      className="flex flex-wrap gap-1 mb-1.5"
                      data-testid={`custom-feed-matched-${s.id}`}
                    >
                      {s.matchedKeywords.map((k) => (
                        <Badge
                          key={k}
                          variant="secondary"
                          className="text-[10px] gap-1"
                          data-testid={`custom-feed-matched-badge-${s.id}-${k}`}
                        >
                          <Search className="w-2.5 h-2.5" />
                          {k}
                        </Badge>
                      ))}
                    </div>
                  )}
                  <p className="text-sm font-medium leading-snug line-clamp-3">
                    {s.headline || s.displayTitle || s.title}
                  </p>
                  <div className="mt-1.5 text-[11px] text-muted-foreground truncate">
                    {s.source}
                    {s.sourceCount > 1 && ` · ${s.sourceCount} sources`}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );

  // Render a single movable feed for the LEFT column (social feeds at "sm"
  // scale; custom feed and DataMinr as their full sections).
  const renderMovableFeedLeft = (key: MovableFeedKey): React.ReactNode => {
    switch (key) {
      case "truth":
        return renderLeftSocialSection(
          "section-truth-social",
          "Truth Social",
          renderTruthNode("sm"),
          undefined,
          <SectionMethodologyTooltip
            section="truth-social"
            testId="tooltip-section-truth-social-left-methodology"
          >
            Posts from Truth Social, a platform used by U.S. political figures
            including the President — a primary channel for official statements
            and policy signals. Shown for situational awareness; not
            fact-checked news.
          </SectionMethodologyTooltip>,
        );
      case "secwar":
        return renderLeftSocialSection(
          "section-secwar",
          "U.S. X Feed",
          renderUsXNode("sm"),
          usXFeedDropdown,
          <SectionMethodologyTooltip
            section="x-feed"
            testId="tooltip-section-us-x-left-methodology"
          >
            Posts from curated U.S. officials, senior military leaders, and key
            national-security figures on X — a real-time window into official
            statements and developing situations.
          </SectionMethodologyTooltip>,
        );
      case "osint":
        return renderLeftSocialSection(
          "section-osint",
          "OSINT X Feed",
          renderOsintNode("sm"),
          osintFeedDropdown,
          <SectionMethodologyTooltip
            section="x-feed"
            testId="tooltip-section-osint-left-methodology"
          >
            Posts from OSINT analysts, defense military accounts, and combatant
            commands on X — early signals and situational awareness before major
            outlets publish.
          </SectionMethodologyTooltip>,
        );
      case "press":
        return renderLeftSocialSection(
          "section-press",
          "Press X Feed",
          renderPressNode("sm"),
          pressFeedDropdown,
          <SectionMethodologyTooltip
            section="x-feed"
            testId="tooltip-section-press-left-methodology"
          >
            Posts from defense and national-security journalists and
            correspondents on X — reporter-level alerts, breaking coverage, and
            story leads.
          </SectionMethodologyTooltip>,
        );
      case "customFeed":
        return renderCustomFeedSection();
      case "firstAlert":
        return renderFirstAlertSection();
    }
  };

  // Highlights carousel (IE + MCOP) as a board-placeable builder. laneKeys
  // are the highlights sections present in the lane being rendered, so the
  // same builder can host both panes (default carousel) or just one when
  // they are split across lanes/columns.
  const renderHighlightsColumn = (
    laneKeys: BoardSectionKey[] = ["mcopHighlights", "ieHighlights"],
  ): React.ReactNode => {
              // ---- IE Highlights pane (Task #223) -------------------------
              // The IE Highlights content is unchanged in behavior; it is just
              // lifted out of its own <section> so the rotating carousel can host
              // it as one pane. Its per-state title/actions/body are computed here
              // and handed to RotatingColumn, which only shows a pane's actions
              // while that pane is active.
              type Pane = {
                key: string;
                title: string;
                demo?: boolean;
                actions?: React.ReactNode;
                tooltip?: React.ReactNode;
                node: React.ReactNode;
                intervalMs?: number;
              };
              // Plain-language explainers for the two acronym pane titles, shown
              // via the SectionHeading (i) icon so a non-technical reader knows
              // what "IE" / "MCOP" mean without leaving the page.
              const ieTooltip = (
                <SectionMethodologyTooltip
                  section="ie-highlights"
                  testId="tooltip-section-ie-highlights-methodology"
                >
                  <span className="font-semibold">IE</span> stands for{" "}
                  <span className="font-semibold">Information Environment</span> —
                  a recurring summary of the biggest narratives shaping
                  defense and national-security news, drawn from the latest news
                  scrub. The Morning and Evening News Scrubs run twice daily on
                  weekdays (and once each weekend day).
                </SectionMethodologyTooltip>
              );
              const mcopTooltip = (
                <SectionMethodologyTooltip
                  section="mcop-highlights"
                  testId="tooltip-section-mcop-highlights-methodology"
                >
                  The top and emerging stories from across MCOP's coverage, split
                  into{" "}
                  <span className="font-semibold">U.S. Domestic</span> and{" "}
                  <span className="font-semibold">International</span> buckets by
                  media ecosystem — what is most prominent in the U.S. mainstream
                  press vs. the international mainstream press.
                </SectionMethodologyTooltip>
              );
              let iePane: Pane;
              // True when the IE pane has no real content to read yet — it's
              // still loading or has collapsed to the stale "Last Updated" card.
              // In that case the carousel only flashes IE briefly and lingers on
              // MCOP Highlights instead.
              let ieCondensed = false;
              if (ieHighlightsLoading) {
                ieCondensed = true;
                iePane = {
                  key: "ie",
                  title: "IE Highlights",
                  node: (
                    <div className="space-y-3 mt-2" data-testid="loading-ie-highlights">
                      {[0, 1].map((i) => (
                        <div key={i} className="space-y-1.5">
                          <div className="h-3 w-28 rounded-sm bg-muted animate-pulse" />
                          <div className="h-4 w-full rounded-sm bg-muted animate-pulse" />
                          <div className="h-4 w-5/6 rounded-sm bg-muted animate-pulse" />
                        </div>
                      ))}
                    </div>
                  ),
                };
              } else if (!ieHighlights?.groups?.length) {
                // No parsed IE highlights to show yet. Rather than fabricated
                // placeholder/demo rows, show a plainly-worded empty state. The
                // pane is condensed so the carousel only flashes it briefly and
                // lingers on MCOP Highlights instead.
                ieCondensed = true;
                iePane = {
                  key: "ie",
                  title: "IE Highlights",
                  node: (
                    <div
                      className="border border-border rounded-md p-6 text-center text-sm text-muted-foreground mt-1"
                      data-testid="empty-ie-highlights"
                    >
                      No IE highlights available yet.
                    </div>
                  ),
                };
              } else {
                const groupsToRender = ieHighlights.groups;
                const asOfDate = ieHighlights?.caoDate ? new Date(ieHighlights.caoDate) : new Date();
                const subTone = "text-muted-foreground";
                const asOfValid = !Number.isNaN(asOfDate.getTime());
                const stamp = asOfValid
                  ? asOfDate.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })
                  : "—";
                const ieActions = (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-[11px] whitespace-nowrap px-1.5"
                      onClick={() => latestScrub && setScrubViewerOpen(true)}
                      disabled={!latestScrub}
                      data-testid="button-ie-see-more"
                    >
                      More
                    </Button>
                    {latestScrub ? (
                      <a
                        href={`/api/curated/news-scrub/${latestScrub.id}/download`}
                        download
                        data-testid="link-ie-download"
                      >
                        <Button size="sm" variant="outline" className="px-1.5" data-testid="button-ie-download">
                          <Download className="h-4 w-4" />
                        </Button>
                      </a>
                    ) : (
                      <Button size="sm" variant="outline" disabled className="px-1.5" data-testid="button-ie-download">
                        <Download className="h-4 w-4" />
                      </Button>
                    )}
                  </>
                );
                // Staleness collapse: once the latest uploaded scrub is older than
                // 20h, the parsed highlights are no longer "current" enough to lead
                // the column — collapse to a compact "Last Updated" card whose only
                // action re-opens the last uploaded scrub. Demo/placeholder data is
                // never considered stale (asOfDate is "now"); a malformed date is
                // ignored rather than collapsing the panel.
                const STALE_MS = 20 * 60 * 60 * 1000;
                const isStale = !!ieHighlights?.caoDate && asOfValid && Date.now() - asOfDate.getTime() > STALE_MS;
                if (isStale) {
                  ieCondensed = true;
                  iePane = {
                    key: "ie",
                    title: "IE Highlights",
                    actions: ieActions,
                    node: (
                      <div className="rounded-md border p-3 mt-1 shadow-md shadow-black/30" data-testid="ie-stale">
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="text-ie-last-updated">
                          <Clock className="h-3.5 w-3.5 shrink-0" />
                          <span>Last Updated {stamp}</span>
                        </div>
                      </div>
                    ),
                  };
                } else {
                  iePane = {
                    key: "ie",
                    title: "IE Highlights",
                    actions: ieActions,
                    node: (
                      <>
                        <p
                          className={`text-[11px] font-normal mb-1.5 ${subTone}`}
                          data-testid="text-ie-intro"
                        >
                          {formatIeHighlightsIntro(asOfDate)}
                        </p>

                        <div className="space-y-3" data-testid="list-ie-highlights">
                          {groupsToRender.map((g) => (
                            <div key={g.group} className="curated-tile curated-tile-pad rounded-md" data-testid={`ie-group-${g.group}`}>
                              <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-curated-accent-strong">
                                {(() => {
                                  const gu = g.group.toUpperCase();
                                  if (gu.includes("GLOBAL")) return <Globe className="h-3.5 w-3.5 shrink-0" />;
                                  if (gu.includes("PENTAGON") || gu.includes("NATSEC")) return <Pentagon className="h-3.5 w-3.5 shrink-0" />;
                                  if (gu.includes("DOMESTIC")) return <UsFlagIcon className="h-3.5 w-3.5 shrink-0" />;
                                  return null;
                                })()}
                                <span>{g.group}</span>
                              </div>
                              {g.trending.length > 0 && (
                                <ul className="list-disc list-outside pl-4 space-y-0.5 text-sm leading-tight mt-1">
                                  {g.trending.map((t, i) => (
                                    <li key={i}>{formatIeNarrativeLabel(t)}</li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          ))}
                        </div>
                      </>
                    ),
                  };
                }
              }

              iePane.tooltip = ieTooltip;

              // ---- MCOP Highlights pane (renamed from "MCOP Overview") ------
              // Restyled to the compact/lighter IE Highlights look: smaller banner
              // (IE group-header style), smaller source icon, denser rows — so the
              // carousel area stays close to IE Highlights' height. Bucketing,
              // Top Headline + Emerging selection, and click-to-open are unchanged.
              const renderNarrativeButton = (
                s: NarrativeItem,
                label?: { text: string; emerging?: boolean },
              ) => (
                <button
                  key={s.id}
                  className="curated-tile w-full text-left rounded-md p-1.5 hover-elevate"
                  onClick={() => openNarrative(s)}
                  data-testid={`narrative-${s.id}`}
                >
                  {label && (
                    <div className="flex items-center gap-0.5 text-[10px] font-sans font-bold uppercase tracking-wider text-muted-foreground mb-0.5">
                      {label.emerging && (
                        <TrendingUp className="h-3 w-3 text-curated-accent-strong" />
                      )}
                      {label.text}
                    </div>
                  )}
                  <p className="text-sm leading-tight">
                    {s.title}
                    <ExternalLink className="inline-block h-3 w-3 ml-1 align-text-bottom opacity-40" />
                    {s.source && (
                      <span className="text-[11px] text-muted-foreground ml-1.5">{s.source}</span>
                    )}
                  </p>
                </button>
              );
              const mcopPane: Pane = {
                key: "mcop",
                title: "MCOP Highlights",
                tooltip: mcopTooltip,
                node: storiesLoading ? (
                  <div className="space-y-2">
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />
                    ))}
                  </div>
                ) : domesticNarratives.length === 0 && intlNarratives.length === 0 ? (
                  <div
                    className="border border-border rounded-md p-6 text-center text-sm text-muted-foreground mt-1"
                    data-testid="empty-top-narratives"
                  >
                    No highlights available right now.
                  </div>
                ) : (
                  <div className="space-y-2.5" data-testid="list-top-narratives">
                    {[
                      { label: "U.S. Domestic", items: domesticNarratives, geo: "domestic" },
                      { label: "International", items: intlNarratives, geo: "international" },
                    ].map((bucket) => {
                      if (bucket.items.length === 0) return null;
                      const top = bucket.items[0];
                      const emerging = pickEmerging(bucket.items);
                      return (
                        <div key={bucket.label}>
                          {/* Banner header. Articles are bucketed by MEDIA
                              ECOSYSTEM (the publishing outlet's registry class —
                              US mainstream press vs. international mainstream
                              press), ranked by their own individual priority.
                              Compact IE-style header. */}
                          <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-curated-accent-strong mb-1">
                            {bucket.label === "U.S. Domestic" ? (
                              <UsFlagIcon className="h-3.5 w-3.5 shrink-0" />
                            ) : (
                              <Globe className="h-3.5 w-3.5 shrink-0" />
                            )}
                            <span
                              data-testid={
                                bucket.label === "U.S. Domestic"
                                  ? "text-domestic-flag-label"
                                  : undefined
                              }
                            >
                              {bucket.label}
                            </span>
                          </div>

                          {/* TOP HEADLINE — the #1 story by priority in this bucket.
                              Its label now rides inline on the article metadata row. */}
                          <div className="space-y-1" data-testid={`top-headline-${bucket.geo}`}>
                            {renderNarrativeButton(top, { text: "Top Headline" })}
                          </div>

                          {/* EMERGING — a DIFFERENT story that is breaking or gaining
                              traction (most recent, preferring multi-source). Its
                              label now rides inline on the article metadata row. */}
                          {emerging && (
                            <div className="space-y-1 mt-1.5" data-testid={`emerging-${bucket.geo}`}>
                              {renderNarrativeButton(emerging, { text: "Emerging", emerging: true })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ),
              };

              // Configure Layout gates each pane independently; the whole column
              // disappears when both are hidden. Lane membership (Task #322
              // wiring) decides which panes THIS carousel hosts: a highlights key
              // only contributes when it is in this lane AND toggled on.
              const wantIe =
                laneKeys.includes("ieHighlights") && showIeHighlights;
              const wantMcop =
                laneKeys.includes("mcopHighlights") && showMcopHighlights;
              if (!wantIe && !wantMcop) return null;
              const highlightPanes: Pane[] = [];
              if (wantIe) {
                highlightPanes.push({
                  ...iePane,
                  intervalMs: ieCondensed
                    ? IE_CONDENSED_DWELL_MS
                    : HIGHLIGHTS_ROTATE_INTERVAL_MS,
                });
              }
              if (wantMcop) {
                highlightPanes.push({
                  ...mcopPane,
                  intervalMs: ieCondensed
                    ? MCOP_LONG_DWELL_MS
                    : HIGHLIGHTS_ROTATE_INTERVAL_MS,
                });
              }
              return (
                <RotatingColumn
                  panes={highlightPanes}
                  sectionTestId="section-ie-highlights"
                  keyPrefix="highlights"
                  heightClass="h-[200px]"
                  intervalMs={HIGHLIGHTS_ROTATE_INTERVAL_MS}
                />
              );
  };

  // Aerial View (Competing Coverage) as a board-placeable builder. Returns
  // null when hidden or when there is no data, exactly as before.
  const renderAerialSection = (): React.ReactNode => {
              if (!showAerial) return null;
              const cc = competingCoverage;
              const hasData =
                !!cc && (cc.domestic.length > 0 || cc.international.length > 0);
              if (!hasData) return null;
              const stamp = cc!.updatedAt
                ? new Date(cc!.updatedAt).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : null;
              const buzz = (cc!.buzz ?? []).filter((b) => !!b.headline);
              const buckets = [
                { label: "U.S. Domestic", items: cc!.domestic, testid: "domestic", max: aerialDomesticMax, show: showAerialDomestic },
                { label: "International", items: cc!.international, testid: "international", max: aerialIntlMax, show: showAerialIntl },
              ];
              // Nothing visible once every Aerial sub-section is toggled off — hide
              // the whole panel rather than render an empty header.
              const anyAerialVisible =
                (showAerialDomestic && cc!.domestic.length > 0) ||
                (showAerialIntl && cc!.international.length > 0) ||
                (showAerialTrending && buzz.length > 0);
              if (!anyAerialVisible) return null;
              const renderItem = (
                item: CompetingCoverageItem,
                testid: string,
              ) => (
                <li
                  key={`${testid}-${item.rank}`}
                  className="curated-tile rounded-md px-2 py-1 text-sm leading-snug"
                  data-testid={`competing-${testid}-${item.rank}`}
                >
                  {/* The rank number is INLINE with the headline so only the
                      first line is indented by it; the headline then wraps to
                      the full column width with continuation lines flush left. */}
                  <span className="font-bold text-curated-accent-strong tabular-nums mr-1.5">
                    {item.rank}
                  </span>
                  {item.url ? (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group hover:underline"
                      data-testid={`link-competing-${testid}-${item.rank}`}
                    >
                      {item.headline}
                      <ExternalLink className="inline-block h-3 w-3 ml-1 align-text-bottom opacity-50 group-hover:opacity-100" />
                    </a>
                  ) : (
                    <span>{item.headline}</span>
                  )}
                  {/* Metadata now follows the headline INLINE (right after the
                      pop-out link) instead of on its own line below, keeping its
                      smaller font sizes. Each segment gets a small left margin so
                      it reads "headline ↗ Source · Blind spot · Category". */}
                  {item.source && (
                    <span className="text-[11px] text-muted-foreground ml-1.5">
                      {item.source}
                    </span>
                  )}
                  {item.blindSpot && (
                    <Badge
                      variant="outline"
                      className="border-curated-accent/60 text-curated-accent-strong text-[9px] uppercase tracking-wider ml-1.5 align-middle"
                      data-testid={`badge-blindspot-${testid}-${item.rank}`}
                    >
                      Blind spot
                    </Badge>
                  )}
                  {item.blindSpot && item.category && (
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground ml-1.5">
                      {item.category}
                    </span>
                  )}
                </li>
              );
              return (
                <section className="border-t border-border pt-4" data-testid="section-competing-coverage">
                  <SectionHeading
                    title="Aerial View"
                    tooltip={
                      <SectionMethodologyTooltip
                        section="aerial-view"
                        testId="tooltip-section-aerial-view-methodology"
                      >
                        The stories the wider press is covering most right now —
                        independent of MCOP ranking. Anything not already in your
                        feed is tagged a{" "}
                        <span className="text-curated-accent-strong">
                          blind spot
                        </span>
                        .
                      </SectionMethodologyTooltip>
                    }
                  />
                  <div className="space-y-3" data-testid="list-competing-coverage">
                    {buckets.map((b) => {
                      if (!b.show || b.items.length === 0) return null;
                      const expanded = !!aerialExpanded[b.testid];
                      // The configured max is the SIZE OF THE POOL (how many are
                      // "there"), not the visible count. We always show the top 3
                      // collapsed; "See more" reveals the rest of the pool.
                      const pool = b.items.slice(0, b.max);
                      const shown = expanded
                        ? pool
                        : pool.slice(0, AERIAL_COLLAPSED_COUNT);
                      const hiddenCount = pool.length - shown.length;
                      return (
                        <div key={b.label}>
                          <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-curated-accent-strong mb-1">
                            {b.label === "U.S. Domestic" ? (
                              <UsFlagIcon className="h-3.5 w-3.5 shrink-0" />
                            ) : (
                              <Globe className="h-3.5 w-3.5 shrink-0" />
                            )}
                            <span>{b.label}</span>
                          </div>
                          <ol className="space-y-0.5">
                            {shown.map((item) => renderItem(item, b.testid))}
                          </ol>
                          {pool.length > AERIAL_COLLAPSED_COUNT && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="mt-0.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-curated-accent-strong"
                              onClick={() =>
                                setAerialExpanded((prev) => ({
                                  ...prev,
                                  [b.testid]: !expanded,
                                }))
                              }
                              data-testid={`button-aerial-see-more-${b.testid}`}
                            >
                              {expanded ? "See less" : `See more (${hiddenCount})`}
                            </Button>
                          )}
                        </div>
                      );
                    })}
                    {showAerialTrending && buzz.length > 0 && (
                      <div data-testid="block-competing-buzz">
                        <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-curated-accent-strong mb-1">
                          <TrendingUp className="h-3.5 w-3.5 shrink-0" />
                          <span>Trending Now</span>
                        </div>
                        <ol className="space-y-0.5">
                          {buzz.map((item, i) => (
                            <li
                              key={`buzz-${i}`}
                              className="curated-tile rounded-md flex gap-2 px-2 py-1"
                              data-testid={`competing-buzz-${i}`}
                            >
                              <Search className="h-4 w-4 mt-0.5 shrink-0 text-curated-accent-strong" />
                              <div className="min-w-0 space-y-0.5">
                                {item.category && (
                                  <div className="text-[11px] uppercase tracking-wide text-curated-accent-strong">
                                    {item.category}
                                  </div>
                                )}
                                {item.url ? (
                                  <a
                                    href={item.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="group inline-flex items-start gap-1 text-sm leading-snug hover:underline"
                                    data-testid={`link-competing-buzz-${i}`}
                                  >
                                    <span>{item.headline}</span>
                                    <ExternalLink className="h-3 w-3 mt-0.5 shrink-0 opacity-50 group-hover:opacity-100" />
                                  </a>
                                ) : (
                                  <span className="text-sm leading-snug">
                                    {item.headline}
                                  </span>
                                )}
                                {item.source && (
                                  <div className="text-[11px] text-muted-foreground">
                                    {item.source}
                                  </div>
                                )}
                              </div>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </div>
                  {stamp && (
                    <p
                      className="text-[10px] font-mono mt-1.5 text-muted-foreground"
                      data-testid="text-competing-coverage-asof"
                    >
                      via Google News · as of {stamp}
                    </p>
                  )}
                </section>
              );
  };

  // Movable-feed keys, for narrowing a board section key to a feed renderer.
  const MOVABLE_FEED_KEY_SET = new Set<MovableFeedKey>(MOVABLE_FEED_ORDER);
  const HIGHLIGHT_SECTION_KEYS = new Set<BoardSectionKey>([
    "mcopHighlights",
    "ieHighlights",
  ]);
  // Sections that never render as standalone column content: header items live
  // in the header, Top Stories is the locked middle column. Skipped defensively
  // if a manual board edit ever drops one into a left/right slot.
  const NON_COLUMN_SECTION_KEYS = new Set<BoardSectionKey>([
    "ticker",
    "searchBar",
    "mcopBot",
    "topStories",
  ]);

  // Whether the section that renders immediately AFTER position `idx` in the
  // key sequence `seq` draws its OWN top divider (Custom Feed and Aerial both do
  // — `border-t`). State-controlled Narratives uses this to drop its bottom
  // divider when such a section lands directly beneath it in the same column, so
  // the two borders don't stack into a doubled rule at the seam. Scans forward
  // skipping keys that won't render as standalone column content (header items /
  // Top Stories, "off" feeds); highlights render but draw no top border.
  const nextSectionDrawsTopBorder = (
    seq: BoardSectionKey[],
    idx: number,
  ): boolean => {
    for (let j = idx + 1; j < seq.length; j++) {
      const k = seq[j];
      if (NON_COLUMN_SECTION_KEYS.has(k)) continue;
      if (HIGHLIGHT_SECTION_KEYS.has(k)) {
        // The highlights carousel draws no top border, so when it renders it can
        // never double a seam — keep our bottom border (return false). But a
        // highlights pane that is toggled OFF produces no section at all (mirror
        // renderHighlightsColumn's `!wantIe && !wantMcop` guard), so skip past
        // it to whatever section actually renders next — which may be a
        // top-border Custom Feed / Aerial we'd otherwise miss.
        const renders =
          (k === "ieHighlights" && showIeHighlights) ||
          (k === "mcopHighlights" && showMcopHighlights);
        if (renders) return false;
        continue;
      }
      // Aerial draws a top border, but only when it's toggled on (it otherwise
      // renders null); an off Aerial is skipped so we don't suppress our bottom
      // border for a section that won't appear.
      if (k === "aerial") {
        if (showAerial) return true;
        continue;
      }
      if (MOVABLE_FEED_KEY_SET.has(k as MovableFeedKey)) {
        if (movableFeedPlacements[k as MovableFeedKey] === "off") continue;
        return k === "customFeed";
      }
      return false;
    }
    return false;
  };

  // Render every section the board placed in the given column slots, in board
  // order (Task #322 live wiring). POSITION comes from board membership; feed
  // VISIBILITY stays on the existing on/off placement gate. Highlights (IE +
  // MCOP) collapse into ONE rotating carousel per lane; Aerial and the movable
  // feeds render as their own sections via the shared builders.
  const renderColumnSlots = (slots: BoardSlotId[]): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    for (const slot of slots) {
      const lanes = boardLayout.lanes[slot] ?? [[]];
      lanes.forEach((lane, laneIdx) => {
        const laneHighlightKeys = lane.filter((k) =>
          HIGHLIGHT_SECTION_KEYS.has(k),
        );
        let highlightsEmitted = false;
        lane.forEach((key, keyIdx) => {
          if (NON_COLUMN_SECTION_KEYS.has(key)) return;
          if (HIGHLIGHT_SECTION_KEYS.has(key)) {
            // All highlights in a lane share ONE carousel, emitted at the first
            // highlights key's position; later highlights keys are absorbed.
            if (highlightsEmitted) return;
            highlightsEmitted = true;
            const node = renderHighlightsColumn(laneHighlightKeys);
            if (node) {
              out.push(
                cloneElement(node as React.ReactElement, {
                  key: `${slot}-${laneIdx}-highlights`,
                }),
              );
            }
            return;
          }
          if (key === "aerial") {
            const node = renderAerialSection();
            if (node) {
              out.push(
                cloneElement(node as React.ReactElement, {
                  key: `${slot}-${laneIdx}-aerial`,
                }),
              );
            }
            return;
          }
          if (key === "stateNarratives") {
            const node = renderStateNarrativesSection({
              nextDrawsTopBorder: nextSectionDrawsTopBorder(lane, keyIdx),
            });
            if (node) {
              out.push(
                cloneElement(node as React.ReactElement, {
                  key: `${slot}-${laneIdx}-state-narratives`,
                }),
              );
            }
            return;
          }
          if (MOVABLE_FEED_KEY_SET.has(key as MovableFeedKey)) {
            const feedKey = key as MovableFeedKey;
            // Visibility is still the on/off gate; board only decides position.
            if (movableFeedPlacements[feedKey] === "off") return;
            const node = renderMovableFeedLeft(feedKey);
            if (node) {
              out.push(
                cloneElement(node as React.ReactElement, {
                  key: `${slot}-${laneIdx}-${feedKey}`,
                }),
              );
            }
          }
        });
      });
    }
    return out;
  };

  // LEFT pane for 2-section page mode (follow-up #323). Collects every ON,
  // column-eligible section the board placed — across L1/L2/R1/R2 in reading
  // order — EXCEPT Top Stories and Custom Feed (those live in the right pane),
  // then distributes them round-robin into `boardLayout.leftCols` sub-columns.
  // Highlights (IE + MCOP) collapse into ONE shared carousel, mirroring the
  // 3-column behavior. Reuses the same section renderers so markup is identical.
  const renderTwoColLeft = (): React.ReactNode => {
    const order: BoardSectionKey[] = [];
    const seen = new Set<BoardSectionKey>();
    for (const slot of ["l1", "l2", "r1", "r2"] as BoardSlotId[]) {
      for (const lane of boardLayout.lanes[slot] ?? []) {
        for (const key of lane) {
          if (NON_COLUMN_SECTION_KEYS.has(key)) continue; // header items + topStories
          if (key === "customFeed") continue; // right pane only
          if (seen.has(key)) continue;
          seen.add(key);
          order.push(key);
        }
      }
    }

    const highlightKeys = order.filter((k) => HIGHLIGHT_SECTION_KEYS.has(k));

    // Build the ordered list of section KEYS that will actually render (the
    // "plan") and round-robin them into sub-columns. Distributing KEYS (not
    // pre-rendered nodes) gives each column an accurate key sequence so a
    // section can read its true in-column neighbor below — State-controlled
    // Narratives uses this to suppress its bottom divider when a top-border
    // section (e.g. Aerial) follows it in the SAME sub-column.
    // Pre-render every non-State-Narratives section now and keep ONLY the keys
    // that actually produce a node — a section that renders null (e.g. both
    // Highlights panes hidden) must NOT consume a column slot, exactly as the
    // prior node-based round-robin behaved. State Narratives is the lone
    // exception: it's rendered per-column below so it can read its true
    // in-column neighbor for the divider, but its renderability doesn't depend
    // on that option, so we gate it on the same cheap predicate the renderer
    // uses. Distributing only renderable keys keeps placement identical to
    // before while still giving each column an accurate key sequence.
    const highlightsNode = highlightKeys.length
      ? renderHighlightsColumn(highlightKeys)
      : null;
    // All highlights collapse into ONE carousel here, so the plan can only carry
    // a single representative key for it. Pick a key whose toggle is actually ON
    // (guaranteed to exist whenever `highlightsNode` is truthy) rather than just
    // the first highlight key in board order: nextSectionDrawsTopBorder reads a
    // highlight key's own toggle to decide if the carousel renders, so a stale
    // OFF representative (e.g. IE off while MCOP on) would make it wrongly treat
    // the carousel as absent and mis-suppress State Narratives' bottom divider.
    const repHighlightKey = highlightKeys.find(
      (k) =>
        (k === "ieHighlights" && showIeHighlights) ||
        (k === "mcopHighlights" && showMcopHighlights),
    );
    const nodeCache = new Map<BoardSectionKey, React.ReactNode>();
    const plan: BoardSectionKey[] = [];
    let highlightsPlanned = false;
    for (const key of order) {
      if (HIGHLIGHT_SECTION_KEYS.has(key)) {
        if (highlightsPlanned || !highlightsNode || !repHighlightKey) continue;
        highlightsPlanned = true;
        nodeCache.set(
          repHighlightKey,
          cloneElement(highlightsNode as React.ReactElement, {
            key: "2col-highlights",
          }),
        );
        plan.push(repHighlightKey);
        continue;
      }
      if (key === "aerial") {
        const node = renderAerialSection();
        if (!node) continue;
        nodeCache.set(
          key,
          cloneElement(node as React.ReactElement, { key: "2col-aerial" }),
        );
        plan.push(key);
        continue;
      }
      if (key === "stateNarratives") {
        // Mirrors the renderer's own null guard; the divider variant chosen
        // per-column below never changes whether it renders.
        if (!showStateNarratives || stateNarrativeCountries.length === 0)
          continue;
        plan.push(key); // node built per-column for correct divider adjacency
        continue;
      }
      if (MOVABLE_FEED_KEY_SET.has(key as MovableFeedKey)) {
        const feedKey = key as MovableFeedKey;
        if (movableFeedPlacements[feedKey] === "off") continue;
        const node = renderMovableFeedLeft(feedKey);
        if (!node) continue;
        nodeCache.set(
          key,
          cloneElement(node as React.ReactElement, { key: `2col-${feedKey}` }),
        );
        plan.push(key);
      }
    }

    const colCount = boardLayout.leftCols;
    const columnKeys: BoardSectionKey[][] = Array.from(
      { length: colCount },
      () => [] as BoardSectionKey[],
    );
    plan.forEach((key, i) => columnKeys[i % colCount].push(key));

    // Nothing to render — return null so the outer two-column layout can
    // collapse the left pane entirely instead of reserving an empty gutter.
    if (plan.length === 0) return null;

    const columns: React.ReactNode[][] = columnKeys.map((colKeys) =>
      colKeys
        .map((key, idx) => {
          if (key === "stateNarratives") {
            const node = renderStateNarrativesSection({
              nextDrawsTopBorder: nextSectionDrawsTopBorder(colKeys, idx),
            });
            return node
              ? cloneElement(node as React.ReactElement, {
                  key: "2col-state-narratives",
                })
              : null;
          }
          return nodeCache.get(key) ?? null;
        })
        .filter((n): n is React.ReactElement => n != null),
    );
    // Drop sub-columns that ended up empty so they don't reserve grid space.
    const renderedColumns = columns.filter((col) => col.length > 0);
    if (renderedColumns.length === 0) return null;
    const effectiveCols = renderedColumns.length;
    const gridColsClass =
      effectiveCols >= 2 ? "lg:grid-cols-2" : "lg:grid-cols-1";

    return (
      <div
        className={`grid grid-cols-1 ${gridColsClass} gap-x-5 gap-y-5${effectiveCols === 1 ? " max-w-2xl" : ""}`}
        data-testid="region-two-col-left"
      >
        {renderedColumns.map((colNodes, ci) => (
          <div key={ci} className="space-y-5 min-w-0">
            {colNodes}
          </div>
        ))}
      </div>
    );
  };

  // State-controlled Narratives (Task #450) — one rotating carousel where each
  // pane is an adversary country's STATE-MEDIA lens (Russia, China, Iran, Cuba,
  // North Korea). The server already auto-hides sparse lenses, so every country
  // present here cleared the freshness floor; we just render what arrives. Each
  // pane shows up to 3 top headlines (by priority) plus one Emerging pick, and a
  // header action opens the full per-country detail dialog. Reuses the shared
  // narrative-row markup and click-to-open (openNarrative) so detail behaves like
  // the MCOP Highlights rows. Curated-lane only, read-only.
  const renderStateNarrativesSection = (opts?: {
    nextDrawsTopBorder?: boolean;
  }): React.ReactNode => {
    if (!showStateNarratives) return null;
    const countries = stateNarrativeCountries;
    if (countries.length === 0) return null;

    const renderRow = (
      s: NarrativeItem,
      label?: { text: string; emerging?: boolean },
    ) => (
      <button
        key={s.id}
        className="curated-tile w-full text-left rounded-md p-1.5 hover-elevate"
        onClick={() => openNarrative(s)}
        data-testid={`state-narrative-${s.id}`}
      >
        <div className="flex items-center gap-x-1 text-[10px] text-curated-accent-strong font-mono mb-0.5 min-w-0 overflow-hidden">
          {label && (
            <>
              <span className="flex items-center gap-0.5 shrink-0 font-sans font-bold uppercase tracking-wider">
                {label.emerging && (
                  <TrendingUp className="h-3 w-3 text-curated-accent-strong" />
                )}
                {label.text}
              </span>
              <span className="shrink-0">·</span>
            </>
          )}
          <span className="shrink-0 whitespace-nowrap">
            {timeAgo(s.articlePublishedAt || s.scrapedAt)}
          </span>
          <span className="shrink-0">·</span>
          <span className="truncate">{s.source}</span>
          {/* Dead-link overlay (Task #630) — a probe-confirmed-dead item with
              no healed replacement is flagged inline so it never reads as a
              normal clickable headline, matching the Top Stories treatment. */}
          {s.linkDead && (
            <DeadLinkCue testId={`badge-state-narrative-link-dead-${s.id}`} />
          )}
        </div>
        <span className="block text-[12px] leading-tight line-clamp-2">
          {s.title}
        </span>
        {/* Feed view shows ONE sentence only — the stored lede, else the first
            summary bullet. The full bullet list (the "long version") is reserved
            for the "See top 5" detail pop-up. */}
        {(() => {
          const line =
            s.summary && s.summary.trim()
              ? s.summary.trim()
              : s.summaryBullets && s.summaryBullets.length > 0
                ? s.summaryBullets[0]
                : null;
          return line ? (
            <div
              className="text-[11px] text-muted-foreground leading-snug mt-1 line-clamp-2"
              data-testid={`text-state-narrative-lede-${s.id}`}
            >
              {line}
            </div>
          ) : null;
        })()}
      </button>
    );

    const panes = countries.map((c) => {
      // Feed (carousel) view shows ONLY the top headline + one Emerging pick;
      // the full top-5 list lives in the "See top 5" detail pop-up.
      const top = c.items.slice(0, 1);
      // "Emerging" must be a story BEYOND the top headline, never a duplicate of
      // it. For a state-MEDIA lens, breadth beats recency: prefer a story from a
      // DIFFERENT outlet than the top headline (the server round-robins outlets
      // into c.items) so the compact pane shows two voices of the apparatus — not
      // the same outlet twice (e.g. TASS + TASS for Russia). Fall back to the
      // recency-based pick when only one outlet is present.
      const topSource = top[0]?.source;
      const tsNum = (it: NarrativeItem) =>
        new Date(it.articlePublishedAt || it.scrapedAt).getTime() || 0;
      const otherOutlet = topSource
        ? c.items.slice(1).filter((it) => it.source !== topSource)
        : [];
      const emerging =
        otherOutlet.length > 0
          ? otherOutlet.reduce(
              (best, it) => (tsNum(it) > tsNum(best) ? it : best),
              otherOutlet[0],
            )
          : pickEmerging(c.items.slice(top.length - 1));
      return {
        key: c.country,
        title: `State Controlled Narratives · ${c.country}`,
        titleNode: (
          <>
            State Controlled Narratives ·{" "}
            <span className="text-curated-accent-strong">{c.country}</span>
          </>
        ),
        tooltip: (
          <SectionMethodologyTooltip
            section="state-controlled-narratives"
            testId="tooltip-section-state-narratives-methodology"
          >
            Coverage from state-controlled outlets, grouped by
            country. These are flagged, attached sources — they never form a
            story on their own. The Topic and Focus shown describe the story's
            content, not the outlet's nationality.
          </SectionMethodologyTooltip>
        ),
        actions: (
          <>
            {/* Freshness/volume cue (Task #632): surfaces the server-computed
                `latestAt`/`count` that previously fed no display — a compact,
                text-only readout (no flags/breakdowns) of how fresh this
                country's apparatus is and how much it's producing right now.
                Fixed single-line text so the rotating column never reflows. */}
            <span
              className="text-[10px] font-mono text-muted-foreground whitespace-nowrap"
              title={
                c.latestAt
                  ? `Latest item ${timeAgo(c.latestAt)} · ${c.count} in window`
                  : `${c.count} in window`
              }
              data-testid={`text-state-narrative-freshness-${c.country}`}
            >
              {c.latestAt ? timeAgo(c.latestAt) : "—"} · {c.count}
            </span>
            {c.count > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[10px] text-muted-foreground"
                onClick={() => setStateNarrativeDetail(c.country)}
                data-testid={`button-state-narrative-detail-${c.country}`}
              >
                See top {Math.min(5, c.count)}
              </Button>
            )}
          </>
        ),
        node: (
          <div className="space-y-1" data-testid={`list-state-narrative-${c.country}`}>
            {top.map((s, i) =>
              renderRow(s, i === 0 ? { text: "Top Headline" } : undefined),
            )}
            {emerging && (
              <div className="mt-1.5">
                {renderRow(emerging, { text: "Emerging", emerging: true })}
              </div>
            )}
          </div>
        ),
      };
    });

    // Page-convention dividers (Custom Feed / Aerial style): always a top rule,
    // and a bottom rule UNLESS the next section in this column already draws its
    // own top border — avoids a doubled rule at the seam. Height is fixed (so
    // the country rotation never reflows neighbors) but right-sized to the
    // compact one-headline-plus-Emerging body.
    return (
      <div
        className={`border-t border-border pt-3 mt-3${
          opts?.nextDrawsTopBorder ? "" : " border-b pb-3"
        }`}
      >
        <RotatingColumn
          panes={panes}
          sectionTestId="section-state-narratives"
          keyPrefix="state-narratives"
          heightClass="h-[152px]"
          headingClassName="text-lg"
          intervalMs={HIGHLIGHTS_ROTATE_INTERVAL_MS}
        />
      </div>
    );
  };

  // Top Stories — the locked surface (Task #322). Rendered in the MIDDLE column
  // in 3-column mode, or the RIGHT pane in 2-section page mode (follow-up #323).
  // Single definition so both modes share identical markup.
  const renderTopStoriesSection = (enlarged: boolean = false): React.ReactNode => {
    // Width-responsive font step-up (Task #800): when the middle column is dragged
    // wider past the hysteresis threshold, its reading text steps up one notch.
    // `enlarged` is passed only from the three-column call site; the two-column
    // call keeps the compact scale. Class strings are centralised here so every
    // text element below just references the same object (mirrors the social
    // feed's CuratedFeedScale sm→md step).
    const tsScale = enlarged
      ? {
          meta: "text-[13px]",
          heroHeadline: "text-[27px]",
          heroBody: "text-[15px]",
          rankedMeta: "text-[12px]",
          rankedHeadline: "text-[18px]",
          rankedLede: "text-[14px]",
        }
      : {
          meta: "text-xs",
          heroHeadline: "text-2xl",
          heroBody: "text-sm",
          rankedMeta: "text-[11px]",
          rankedHeadline: "text-base",
          rankedLede: "text-[13px]",
        };
    return (
            <>
                <SectionHeading
                  title="Top Stories"
                  tooltip={
                    <SectionMethodologyTooltip
                      section="top-stories-and-ranking"
                      testId="tooltip-section-top-stories-methodology"
                    >
                      The most important defense and national-security stories
                      right now, ranked by a blend of importance and freshness.
                      Top Stories can be single-source items or clustered stories
                      drawn from several outlets. As a story ages it settles down
                      the list to let newer developments rise.
                    </SectionMethodologyTooltip>
                  }
                  actions={
                    <>
                      {/* Editor-only combined sort + view control. Sorts
                          reorder the already-loaded, search-filtered Top
                          Stories list ("Priority: High → Low" default reproduces today's
                          ordering unchanged). "Editor views" swap the list
                          BODY instead: Radar (not-surfacing items + promote),
                          Hidden stories (+ un-hide), and Attach candidates
                          (attach-only items linkable into formed stories).
                          Hidden for non-editors and while previewing as
                          public. */}
                      {effectiveAccess && (
                        <Select
                          value={editorViewMode === "feed" ? topStoriesSort : `view:${editorViewMode}`}
                          onValueChange={(v) => {
                            if (v.startsWith("view:")) {
                              setEditorViewMode(v.slice(5) as EditorViewMode);
                            } else {
                              setEditorViewMode("feed");
                              setTopStoriesSort(v as TopStoriesSortMode);
                            }
                          }}
                        >
                          <SelectTrigger
                            className={`h-8 w-auto text-xs gap-1 shadow-none px-2 ${
                              topStoriesSort !== "priority-desc" || editorViewMode !== "feed"
                                ? "bg-curated-accent text-white border border-curated-accent"
                                : "text-curated-accent-strong border border-curated-accent/50 bg-transparent"
                            }`}
                            data-testid="select-top-stories-sort"
                            aria-label="Sort or switch Top Stories view"
                          >
                            <ArrowUpDown className="h-3 w-3 shrink-0" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectLabel className="text-xs text-muted-foreground">Sort</SelectLabel>
                              {TOP_STORIES_SORT_OPTIONS.map((opt) => (
                                <SelectItem
                                  key={opt.value}
                                  value={opt.value}
                                  data-testid={`option-top-stories-sort-${opt.value}`}
                                >
                                  {opt.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                            <SelectSeparator />
                            <SelectGroup>
                              <SelectLabel className="text-xs text-muted-foreground">Editor views</SelectLabel>
                              {EDITOR_VIEW_OPTIONS.map((opt) => (
                                <SelectItem
                                  key={opt.value}
                                  value={`view:${opt.value}`}
                                  data-testid={`option-editor-view-${opt.value}`}
                                >
                                  {opt.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      )}
                      {/* Editor-only "select for consideration" toggle (Task #643).
                          Hidden entirely for non-editors and while previewing as
                          public. */}
                      {effectiveAccess && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setTopStoriesSelectMode((v) => !v)}
                          className={
                            topStoriesSelectMode
                              ? "bg-curated-accent text-white border border-curated-accent"
                              : "text-curated-accent-strong border border-curated-accent/50"
                          }
                          data-testid="button-toggle-top-stories-select"
                        >
                          <ListChecks className="h-3.5 w-3.5 mr-1.5" />
                          {topStoriesSelectMode ? "Selecting…" : "Select"}
                        </Button>
                      )}
                      <Link href="/curated/archive">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Story archive"
                          className="text-muted-foreground [&_svg]:!size-3.5"
                          data-testid="button-open-archive"
                        >
                          <Archive className="h-4 w-4" />
                        </Button>
                      </Link>
                    </>
                  }
                />

                {/* Select-mode action row (Task #643) — count, Link/merge, Clear.
                    Operates ONLY on the currently visible (search-filtered,
                    sorted) ranked list. */}
                {effectiveAccess && topStoriesSelectMode && (
                  <div
                    className="flex items-center gap-2 flex-wrap mb-2.5 -mt-1"
                    data-testid="row-top-stories-select-actions"
                  >
                    <span
                      className="text-xs text-curated-accent-strong font-mono"
                      data-testid="text-top-stories-selected-count"
                    >
                      {topStoriesSelectedKeys.size} selected
                    </span>
                    <TopStoriesLinkMergeControl
                      stories={rankedStories.filter((s) =>
                        topStoriesSelectedKeys.has(storyKey(s)),
                      )}
                      onDone={() => setTopStoriesSelectedKeys(new Set())}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={topStoriesSelectedKeys.size === 0}
                      onClick={() => setTopStoriesSelectedKeys(new Set())}
                      className="text-curated-accent-strong"
                      data-testid="button-clear-top-stories-selection"
                    >
                      <X className="h-3.5 w-3.5 mr-1.5" />
                      Clear
                    </Button>
                  </div>
                )}

                {storiesLoading ? (
                  <div className="space-y-3">
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="h-24 rounded-md bg-muted animate-pulse" />
                    ))}
                  </div>
                ) : heroCount === 0 && rankedStories.length === 0 ? (
                  <div
                    className="border border-border rounded-md p-8 text-center text-sm text-muted-foreground"
                    data-testid="empty-top-stories"
                  >
                    {search.trim()
                      ? "No results found. Try a different search."
                      : "No stories available right now."}
                  </div>
                ) : (
                  <div data-testid="list-ranked-stories">
                    {heroCount > 0 && (() => {
                      const hero = heroStories[heroIndex % heroCount];
                      // Curated lane — clustered stories show up to 2 synthesized
                      // corroborated key facts; single-source rows fall back to the
                      // article's own AI summary bullets.
                      const heroBullets =
                        hero.facts && hero.facts.length > 0
                          ? hero.facts.slice(0, 2)
                          : hero.summaryBullets?.slice(0, 3) ?? [];
                      const goPrev = (e?: React.SyntheticEvent) => {
                        e?.stopPropagation();
                        setHeroIndex((i) => (i - 1 + heroCount) % heroCount);
                      };
                      const goNext = (e?: React.SyntheticEvent) => {
                        e?.stopPropagation();
                        setHeroIndex((i) => (i + 1) % heroCount);
                      };
                      return (
                        <div
                          className="relative rounded-md overflow-hidden mb-4 shadow-md shadow-black/30"
                          data-testid="hero-carousel"
                          role="group"
                          aria-roledescription="carousel"
                          aria-label="Top stories carousel — use the left and right arrow keys to change story"
                          onKeyDown={(e) => {
                            if (heroCount <= 1) return;
                            if (e.key === "ArrowLeft") {
                              e.preventDefault();
                              goPrev();
                            } else if (e.key === "ArrowRight") {
                              e.preventDefault();
                              goNext();
                            }
                          }}
                        >
                          {/* Screen-reader-only live region announces each slide change
                              (auto-rotation + manual). Visual users see the slide itself. */}
                          <span
                            className="sr-only"
                            role="status"
                            aria-live="polite"
                            data-testid="hero-live-region"
                          >
                            {`Story ${(heroIndex % heroCount) + 1} of ${heroCount}: ${
                              hero.headline || hero.displayTitle || hero.title
                            }`}
                          </span>
                          <button
                            type="button"
                            className="relative block w-full text-left min-h-[220px]"
                            onClick={() => setSelectedStory(hero)}
                            data-testid={`hero-slide-${hero.id}`}
                          >
                            {(() => {
                              const single = hero.sourceCount <= 1;
                              const isVideoHero =
                                single &&
                                !!hero.videoUrl &&
                                deriveContentType(hero.url) === "video";
                              const heroImg =
                                resolveArticleImage(
                                  hero.ogImageUrl,
                                  single,
                                  hero.source,
                                );
                              if (isVideoHero) {
                                return (
                                  <>
                                    {/* Still image as poster/fallback layer */}
                                    {heroImg && (
                                      <img
                                        src={heroImg}
                                        alt=""
                                        className="absolute inset-0 w-full h-full object-cover"
                                      />
                                    )}
                                    <video
                                      src={hero.videoUrl!}
                                      autoPlay
                                      muted
                                      loop
                                      playsInline
                                      className="absolute inset-0 w-full h-full object-cover"
                                      data-testid={`video-hero-${hero.id}`}
                                      onError={(e) => {
                                        (e.target as HTMLVideoElement).style.display = "none";
                                      }}
                                    />
                                  </>
                                );
                              }
                              return heroImg ? (
                                <img
                                  src={heroImg}
                                  alt=""
                                  className="absolute inset-0 w-full h-full object-cover"
                                  data-testid={`img-hero-${hero.id}`}
                                />
                              ) : (
                                <div className="absolute inset-0 bg-muted" />
                              );
                            })()}
                            {/* Wash so text is readable over any image. LIGHT mode: a
                                LIGHT wash + dark text to match the light theme. DARK mode:
                                the original dark wash + white text (unchanged). */}
                            <div className="absolute inset-0 bg-gradient-to-r from-white/70 via-white/45 to-transparent dark:from-black/90 dark:via-black/75 dark:to-black/55" />
                            <div className="relative py-4 px-6">
                              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0 mb-2 tracking-tight">
                                {/* Category = the story's specific content subject (accent-blue text).
                                    On wide layouts the row stays on one line (the category
                                    truncates first when space is tight); on narrow screens the
                                    trailing geography/source/time wrap to a second line instead
                                    of crowding or clipping. */}
                                <span className={`${tsScale.meta} font-mono font-semibold text-curated-accent-strong truncate`}>
                                  {storyTopicLabel(hero)}
                                </span>
                                <span className={`${tsScale.meta} text-curated-accent-strong font-mono shrink-0`}>·</span>
                                {/* Geography: content-based country/region, else text heuristic */}
                                <span className={`${tsScale.meta} font-mono text-curated-accent-strong shrink-0 whitespace-nowrap`}>{regionFor(hero).label}</span>
                                {/* Single outlet only when single-source; clustered hero leans on the count */}
                                {hero.sourceCount === 1 && (
                                  <span className={`${tsScale.meta} text-curated-muted font-mono shrink-0 whitespace-nowrap`}>{hero.source}</span>
                                )}
                                <span className={`${tsScale.meta} text-curated-muted font-mono shrink-0 whitespace-nowrap`}>
                                  {/* Honest fallback (matches the detail header): with
                                      no trustworthy original-publish timestamp, prefix
                                      "seen" so scrapedAt (discovery time) is never shown
                                      as a fabricated fresh publish time for a stale item. */}
                                  · {hero.articlePublishedAt ? timeAgo(hero.articlePublishedAt) : `seen ${timeAgo(hero.scrapedAt)}`}
                                </span>
                                {/* Hide "1 source" — only show the count for multi-source stories */}
                                {hero.sourceCount > 1 && (
                                  <span className={`${tsScale.meta} text-curated-muted font-mono shrink-0 whitespace-nowrap`}>
                                    · {hero.sourceCount} sources
                                  </span>
                                )}
                              </div>
                              {/* Clustered stories headline = the short synthesized
                                  generalized headline (no single source's framing).
                                  Single-source rows keep the article's own title. */}
                              <h3 className={`${tsScale.heroHeadline} font-bold leading-tight mb-2 text-slate-900 dark:text-white max-w-2xl`} data-testid={`text-hero-headline-${hero.id}`}>
                                {hero.headline || hero.displayTitle || hero.title}
                              </h3>
                              {heroBullets.length > 0 ? (
                                <ul className="space-y-1 max-w-2xl">
                                  {heroBullets.map((b, i) => (
                                    <li
                                      key={i}
                                      className={`flex gap-2 ${tsScale.heroBody} text-slate-800 dark:text-white/85 leading-snug`}
                                    >
                                      <span aria-hidden>•</span>
                                      <span>{b}</span>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className={`${tsScale.heroBody} text-slate-800 dark:text-white/85 max-w-2xl`}>{hero.summary}</p>
                              )}
                            </div>
                          </button>

                          {heroCount > 1 && (
                            <div className="absolute bottom-3 right-3 flex items-center gap-2 z-10">
                              <Button
                                size="icon"
                                variant="outline"
                                className="rounded-full bg-black/40 backdrop-blur-sm border-white/30 text-white"
                                onClick={goPrev}
                                aria-label="Previous story"
                                data-testid="button-hero-prev"
                              >
                                <ChevronLeft className="h-4 w-4" />
                              </Button>
                              <Button
                                size="icon"
                                variant="outline"
                                className="rounded-full bg-black/40 backdrop-blur-sm border-white/30 text-white"
                                onClick={goNext}
                                aria-label="Next story"
                                data-testid="button-hero-next"
                              >
                                <ChevronRight className="h-4 w-4" />
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    <div
                      ref={topStoriesScrollRef}
                      style={feedMaxH.topStories ? { maxHeight: `${feedMaxH.topStories}px` } : undefined}
                      className="curated-story-list max-w-3xl mx-auto max-h-[calc(100vh-8rem)] overflow-y-auto pr-1"
                    >
                      {/* Editor view modes (Task #834 rework) — swap ONLY the
                          list body inside this scroll container. The hero
                          carousel and the sort pipeline above are untouched,
                          and non-editors can never leave 'feed'. */}
                      {effectiveAccess && editorViewMode === "radar" && (
                        <RadarViewBody
                          active={editorViewMode === "radar"}
                          clusters={formedClusterStories}
                        />
                      )}
                      {effectiveAccess && editorViewMode === "hidden" && (
                        <HiddenViewBody items={hiddenStories} />
                      )}
                      {effectiveAccess && editorViewMode === "link-candidates" && (
                        <LinkCandidatesViewBody
                          active={editorViewMode === "link-candidates"}
                          clusters={formedClusterStories}
                        />
                      )}
                      {(!effectiveAccess || editorViewMode === "feed") && rankedStories.map((s) => {
                        const selectable = effectiveAccess && topStoriesSelectMode;
                        const isSelected = selectable && topStoriesSelectedKeys.has(storyKey(s));
                        const toggleSelected = () => {
                          setTopStoriesSelectedKeys((prev) => {
                            const next = new Set(prev);
                            const k = storyKey(s);
                            if (next.has(k)) next.delete(k);
                            else next.add(k);
                            return next;
                          });
                        };
                        return (
                        <button
                          type="button"
                          key={s.id}
                          className={`block w-full text-left py-2.5 px-2 rounded-md hover-elevate ${isSelected ? "bg-curated-accent/10" : "curated-tile"}`}
                          onClick={() => (selectable ? toggleSelected() : setSelectedStory(s))}
                          data-testid={`card-ranked-${s.id}`}
                        >
                          <div className="flex gap-3 items-center justify-between">
                            {/* "Select for consideration" checkbox (Task #643) —
                                shown only in the header's editor-only Select mode. */}
                            {selectable && (
                              <div className="shrink-0" data-testid={`checkbox-select-story-${s.id}`}>
                                <Checkbox
                                  checked={isSelected}
                                  onCheckedChange={toggleSelected}
                                  onClick={(e) => e.stopPropagation()}
                                  aria-label="Select for consideration"
                                  className="border-curated-accent data-[state=checked]:bg-curated-accent data-[state=checked]:border-curated-accent data-[state=checked]:text-white"
                                />
                              </div>
                            )}
                            {/* Cluster rows (>1 source) drop the single outlet logo —
                                a lone logo misrepresents a multi-source story and the
                                freed width lets the headline/lede block breathe.
                                Single-source rows keep their outlet logo. */}
                            {s.sourceCount === 1 && (
                              <div className="shrink-0">
                                <SourceIcon source={s.source} url={s.url} sizeClass="h-12 w-12" textClass="text-sm" />
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <div className={`flex items-center gap-1.5 mb-1 flex-nowrap min-w-0 overflow-hidden ${tsScale.rankedMeta} font-mono tracking-tight`}>
                                {/* Category·Geography grouped tightly; Category = the story's specific
                                    content subject (accent cyan kicker), Geography = content-based country/region else heuristic.
                                    The row stays on ONE line: the category truncates first when space is
                                    tight while geography/source/time stay fixed (shrink-0).
                                    overflow-hidden clips (never horizontally bleeds) at narrow widths. */}
                                <span className="flex items-center gap-1 min-w-0">
                                  <span className="font-semibold text-curated-accent-strong truncate">{storyTopicLabel(s)}</span>
                                  <span className="text-curated-accent-strong shrink-0">·</span>
                                  <span className="text-curated-accent-strong shrink-0 whitespace-nowrap">{regionFor(s).label}</span>
                                </span>
                                {/* Single outlet only when single-source; clustered rows lean on the count below */}
                                {s.sourceCount === 1 && (
                                  <>
                                    <span className="text-curated-muted shrink-0">·</span>
                                    <span className="text-curated-muted shrink-0 whitespace-nowrap">{s.source}</span>
                                  </>
                                )}
                                <span className="text-curated-muted shrink-0">·</span>
                                <span className="text-curated-muted shrink-0 whitespace-nowrap">
                                  {/* Honest fallback (matches the detail header): with no
                                      trustworthy original-publish timestamp, prefix "seen"
                                      so scrapedAt (discovery time) is never rendered as a
                                      fabricated fresh publish time for a stale item. */}
                                  {s.articlePublishedAt ? timeAgo(s.articlePublishedAt) : `seen ${timeAgo(s.scrapedAt)}`}
                                </span>
                                {/* # sources sits inline on the metadata line above
                                    the headline. Hidden for single-source rows —
                                    "1 source" just restates the lone outlet shown above. */}
                                {s.sourceCount > 1 && (
                                  <>
                                    <span className="text-curated-muted shrink-0">·</span>
                                    <span className="text-curated-muted shrink-0 whitespace-nowrap">
                                      {s.sourceCount} sources
                                    </span>
                                  </>
                                )}
                                {/* Optimistic merge in flight (Task #746) — a subtle
                                    "Grouping…" cue holds the merged card steady until
                                    the query re-fetches the real merged story, so it
                                    never flickers back to separate cards. */}
                                {s._grouping && (
                                  <>
                                    <span className="text-curated-accent-strong shrink-0">·</span>
                                    <span
                                      className="text-curated-accent-strong shrink-0 whitespace-nowrap inline-flex items-center gap-1"
                                      data-testid={`status-grouping-${s.id}`}
                                    >
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                      Grouping…
                                    </span>
                                  </>
                                )}
                                {/* Content-kind (Video/Opinion) flags a SINGLE item's
                                    format. A multi-source cluster is a news story, not
                                    a video — so it never inherits a content-kind tag
                                    from its representative member (the per-source rows
                                    in the detail still flag individual videos). */}
                                {s.sourceCount === 1 && (
                                  <span className="shrink-0">
                                    <ContentKindBadge kind={getEffectiveContentKindWithTitle(s.url, s.title, toStoredContentKind(s.contentKind))} />
                                  </span>
                                )}
                                {/* Curated lane (Task #226) — dead-link cue so a
                                    broken standalone story is spotted at the grid
                                    level, before opening the detail. */}
                                {s.linkDead && (
                                  <DeadLinkCue testId={`badge-link-dead-${s.id}`} />
                                )}
                                {/* The interactive Priority pin (Task #171) lives in
                                    the detail pop-out now; the editor-only VIEW-ONLY
                                    P-score tag sits at the FRONT of this row (above). */}
                              </div>
                              {/* Clustered stories headline = the short synthesized
                                  generalized headline (no single source's framing).
                                  Single-source rows keep the article's own title. */}
                              <h3 className={`${tsScale.rankedHeadline} font-bold leading-snug line-clamp-2`} data-testid={`text-ranked-headline-${s.id}`}>
                                {s.headline || s.displayTitle || s.title}
                              </h3>
                              {/* The neutral synthesized lede sits UNDER the headline
                                  (clustered stories only) — single-source rows have
                                  no lede so this is skipped for them. The static feed
                                  shows ONLY this condensed lede; the full key-fact
                                  bullets are reserved for the hero preview pane and the
                                  detail dialog so the list stays scannable. */}
                              {s.lede && (
                                <p className={`${tsScale.rankedLede} text-muted-foreground leading-snug mt-1 ${s.sourceCount > 1 ? 'line-clamp-3' : 'line-clamp-2'}`} data-testid={`text-ranked-lede-${s.id}`}>
                                  {s.lede}
                                </p>
                              )}
                            </div>
                            {(() => {
                              // Card thumbnail shows either an inline video clip
                              // (single-source video stories) or a static photo.
                              // The full photo carousel lives only in the detail popup.
                              const single = s.sourceCount <= 1;
                              const isVideoStory =
                                single &&
                                !!s.videoUrl &&
                                deriveContentType(s.url) === "video";
                              const cardImage =
                                resolveArticleImage(
                                  s.ogImageUrl ||
                                    (s.memberImages && s.memberImages[0]) ||
                                    null,
                                  single,
                                  s.source,
                                );
                              if (!isVideoStory && !cardImage) return null;
                              return (
                                <div className={`relative shrink-0 ${single ? 'w-24 sm:w-28' : 'w-20 sm:w-24'}`} data-video-thumb>
                                  {/* View-only P-score for editors, anchored snug just
                                      above the card thumbnail. Shown for BOTH single-source
                                      and cluster rows (every row with a photo), so cluster
                                      P-scores are visible at a glance. Editor mode only;
                                      never public. The interactive pin lives in the detail
                                      pop-out. */}
                                  {effectiveAccess && (
                                    <CuratedPriorityTag
                                      story={s}
                                      overlay
                                      testId={`tag-priority-${s.id}`}
                                      hasAccess={effectiveAccess}
                                      rankingCutoffs={rankingCutoffs}
                                    />
                                  )}
                                  {/* 16:9 generally conforms to most article/OG images */}
                                  <div className="relative aspect-video overflow-hidden rounded-md bg-muted shadow-md shadow-black/30">
                                    {isVideoStory ? (
                                      <>
                                        {/* Still image behind the video — acts as poster/fallback
                                            when the clip errors or hasn't loaded yet */}
                                        {cardImage && (
                                          <img
                                            src={cardImage}
                                            alt=""
                                            className="absolute inset-0 w-full h-full object-cover object-center"
                                          />
                                        )}
                                        <video
                                          src={s.videoUrl!}
                                          autoPlay
                                          muted
                                          loop
                                          playsInline
                                          className="absolute inset-0 w-full h-full object-cover"
                                          data-testid={`video-ranked-${s.id}`}
                                          onError={(e) => {
                                            const vid = e.target as HTMLVideoElement;
                                            vid.style.display = "none";
                                            // If there is no still-image fallback behind the
                                            // video, collapse the whole thumbnail container so
                                            // the row shows no empty box.
                                            if (!cardImage) {
                                              const outer = vid.closest<HTMLElement>("[data-video-thumb]");
                                              if (outer) outer.style.display = "none";
                                            }
                                          }}
                                        />
                                      </>
                                    ) : (
                                      <img
                                        src={cardImage!}
                                        alt=""
                                        loading="lazy"
                                        className="w-full h-full object-cover object-center scale-110"
                                        data-testid={`img-ranked-${s.id}`}
                                      />
                                    )}
                                  </div>
                                </div>
                              );
                            })()}
                            {/* HIDE control moved OFF the preview card into the
                                detail hero overlay so the editor's card view ≈ the
                                public view (Task #380 expansion). */}
                          </div>
                        </button>
                        );
                      })}
                    </div>
                  </div>
                )}
            </>
    );
  };

  if (accessLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div
          className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"
          data-testid="curated-loading-spinner"
        />
      </div>
    );
  }

  // Not logged in (or the app session expired): show the MCOP password login
  // right here on /curated instead of bouncing to the home feed. Entering the
  // password sets the standard app session; we then refetch the access check so
  // canView flips true and the Curated view renders in place. View access is the
  // "public" tier (password only); editing still requires the Replit-auth tester
  // allowlist.
  if (hasAccess !== true) {
    return (
      <Login
        onLoginSuccess={() =>
          queryClient.invalidateQueries({ queryKey: ["/api/auth/curated-access"] })
        }
      />
    );
  }

  // The RIGHT column's content below the R1 social bloc (R2 slot). Computed once
  // so r1FillColumn can know whether anything sits below the bloc — when empty,
  // the bloc grows to fill the column height (see the R1 region comment).
  const rightBelowBloc = renderColumnSlots(["r2"]);
  const r1FillColumn = rightBelowBloc.length === 0;
  // LEFT column nodes computed once so the empty-column collapse logic can
  // decide whether to skip rendering the left div and its gutter border.
  const leftColNodes = renderColumnSlots(["l1", "l2"]);
  const hasLeftContent = leftColNodes.length > 0;
  // Right column is non-empty when any R1 social feed is active (placed in r1
  // lanes and not "off") or something below the bloc (r2) rendered.
  const hasRightContent =
    r1Lanes.some((lane) =>
      lane.some((k) => movableFeedPlacements[k as MovableFeedKey] !== "off"),
    ) || rightBelowBloc.length > 0;
  // Two-column mode left pane — computed once so the outer grid can collapse
  // the left div (and its gutter/border) when every section in l1/l2/r1/r2 is
  // hidden or moved to the tray. renderTwoColLeft returns null when plan===0.
  const twoColLeft =
    boardLayout.pageMode === "two" ? renderTwoColLeft() : null;
  const hasTwoColLeft = twoColLeft !== null;

  // Draggable-column support (Task #378 follow-up). Base fr weights mirror the
  // hardcoded grid tracks below; a viewer's slight per-divider nudges are keyed
  // by these base weights so each column combination remembers its own resize.
  // The template is fed to the grid via a CSS var applied at `lg:` only, so the
  // mobile single-column stack is untouched.
  const threeColBase =
    hasLeftContent && hasRightContent
      ? [0.8, 2.05, 1.75]
      : hasLeftContent
        ? [0.8, 2.05]
        : hasRightContent
          ? [2.05, 1.75]
          : null;
  const threeColSig = threeColBase ? threeColBase.join(",") : "";
  const threeColDeltas = (threeColBase && columnWeights[threeColSig]) || [];
  const threeColTemplate = threeColBase
    ? computeColumnTemplate(threeColBase, threeColDeltas)
    : undefined;
  // Per-column minimum pixel widths so a drag can never condense a column until
  // its header (and its trailing controls) wraps to a second line. The left rail
  // stacks single-width sections (IE Highlights / Aerial View); the middle is Top
  // Stories with its sort/Select/archive controls; the right rail packs up to
  // three side-by-side social sub-columns, so it needs the most room.
  const threeColMinPx =
    hasLeftContent && hasRightContent
      ? [200, 380, 440]
      : hasLeftContent
        ? [200, 380]
        : hasRightContent
          ? [380, 440]
          : undefined;
  // Per-column MAXIMUM pixel widths — only the narrow LEFT rail is capped so a
  // drag can't stretch it "super wide" and starve Top Stories / the social bloc.
  // 0 = no ceiling: the middle (Top Stories) and right (social) columns are MEANT
  // to grow when dragged, which is exactly what drives their width-responsive font
  // step-up. The [2.05, 1.75] shape has no left rail, so nothing is capped there.
  const threeColMaxPx =
    hasLeftContent && hasRightContent
      ? [420, 0, 0]
      : hasLeftContent
        ? [420, 0]
        : hasRightContent
          ? [0, 0]
          : undefined;

  // Width-responsive font step-up — derived from the ResizeObserver-reported
  // pixel width of the right column (rightColRef / rightColWidth, initialised
  // near mainGridRef above).
  //
  // We compare the measured width against the right column's EXPECTED width at
  // its base fr weight (no drag): baseRightPx = containerWidth × (rightFr / Σfr).
  // Container width comes from mainGridRef at render time (reading offsetWidth in
  // the render path is safe because it only updates display-side derived state).
  //
  // Hysteresis band (prevents jitter at the drag boundary):
  //   step UP   when rightColWidth ≥ baseRightPx × 1.15  (+15% above base)
  //   step DOWN when rightColWidth < baseRightPx × 1.10  (<+10% above base)
  //   hold the current state in the 10–15% band
  //
  // Only active in three-column mode with the "sm" base scale; two-column and
  // single-column modes are unaffected.
  (() => {
    if (!threeColBase || boardLayout.pageMode !== "three" || rightColWidth === 0) return;
    const containerWidth = mainGridRef.current?.offsetWidth ?? 0;
    if (containerWidth === 0) return;
    const totalFr = threeColBase.reduce((a, b) => a + b, 0);
    const baseRightPx = containerWidth * (threeColBase[threeColBase.length - 1] / totalFr);
    if (rightColWidth >= baseRightPx * 1.15) rightSteppedUpRef.current = true;
    else if (rightColWidth < baseRightPx * 1.10) rightSteppedUpRef.current = false;
    // Between 1.10× and 1.15×: hold existing state (hysteresis).
  })();
  const rightSteppedUp = rightSteppedUpRef.current;

  const twoColBase = hasTwoColLeft ? [1, 1.2] : null;
  const twoColSig = twoColBase ? twoColBase.join(",") : "";
  const twoColDeltas = (twoColBase && columnWeights[twoColSig]) || [];
  const twoColTemplate = twoColBase
    ? computeColumnTemplate(twoColBase, twoColDeltas)
    : undefined;
  // Left pane splits into sub-columns; right pane is Top Stories + Custom Feed.
  const twoColMinPx = twoColBase ? [300, 380] : undefined;
  // Cap the LEFT content pane so a drag can't stretch it "super wide" and starve
  // the Top Stories / Custom Feed pane. 0 = the right pane is uncapped so it can
  // grow when dragged, which is what drives its width-responsive font step-up.
  const twoColMaxPx = twoColBase ? [1100, 0] : undefined;

  // Width-responsive font step-up for the MIDDLE / Top Stories column. Works in
  // BOTH page modes — whichever cell currently holds Top Stories is measured by
  // middleColCallbackRef: the centre cell in three-column mode, or the right
  // pane in two-column mode. Compares the measured width against the column's
  // EXPECTED width at its base fr weight (baseMiddlePx = containerWidth ×
  // middleFr / Σfr) with the same hysteresis band as the right social column:
  //   step UP at ≥ base × 1.15, step DOWN at < base × 1.10, hold in between.
  (() => {
    if (middleColWidth === 0) return;
    const containerWidth = mainGridRef.current?.offsetWidth ?? 0;
    if (containerWidth === 0) return;
    let base: number[] | null = null;
    let idx = -1;
    if (boardLayout.pageMode === "three" && threeColBase) {
      base = threeColBase;
      idx = hasLeftContent ? 1 : 0; // centre cell (index 0 when no left rail)
    } else if (boardLayout.pageMode === "two" && twoColBase) {
      base = twoColBase;
      idx = 1; // Top Stories is the right pane in two-column mode
    }
    if (!base || idx < 0) return;
    const totalFr = base.reduce((a, b) => a + b, 0);
    const baseMiddlePx = containerWidth * (base[idx] / totalFr);
    if (middleColWidth >= baseMiddlePx * 1.15) middleSteppedUpRef.current = true;
    else if (middleColWidth < baseMiddlePx * 1.10) middleSteppedUpRef.current = false;
    // Between 1.10× and 1.15×: hold existing state (hysteresis).
  })();
  const middleSteppedUp = middleSteppedUpRef.current;

  // When Top Stories occupies a full-width SINGLE column (no left rail and no
  // right social bloc, in either page mode) it has the whole page to itself, so
  // render it enlarged unconditionally — this is how "fewer columns = larger
  // fonts" is expressed at the extreme, independent of any drag.
  const topStoriesFullWidth =
    (boardLayout.pageMode === "three" && !threeColBase) ||
    (boardLayout.pageMode === "two" && !hasTwoColLeft);
  const topStoriesEnlarged = topStoriesFullWidth || middleSteppedUp;

  return (
    <OutletIndexContext.Provider value={outletIndex}>
    <div
      className="curated-root h-screen overflow-y-auto curated-scroll bg-background text-foreground"
    >
      <CuratedHeader
        autoRefresh={autoRefresh}
        onAutoRefreshChange={setAutoRefresh}
        onManualRefresh={handleManualRefresh}
        isRefreshing={isRefreshing}
        search={search}
        onSearchChange={setSearch}
        showSearchBar={showSearchBar}
        showMcopBot={showMcopBot}
        onMcopBotOpen={() => setMcopBotOpen(true)}
        // While the walkthrough is open, hide the header's editor affordances too
        // (the "Viewing as editor/public" toggle and Re-cluster) so the tour shows
        // the page exactly as a public viewer sees it. They return once it closes.
        canModerate={canEdit && !tourOpen}
        previewAsPublic={previewAsPublic}
        onTogglePreviewAsPublic={() => setPreviewAsPublic((v) => !v)}
        onConfigure={() => setConfigOpen(true)}
        onRecluster={() => reclusterMutation.mutate()}
        isReclustering={reclusterMutation.isPending}
        onShowTour={() => setOpenerOpen(true)}
        tourButtonPulse={tourButtonPulse}
      />

      {showTicker && (
        <div className="border-b border-border bg-background">
          <MarketTicker enabled variant="dashboard" scrollDurationSeconds={70} backgroundImageUrl={headerStormBg} dense mode={tickerMode} loadingSkeleton />
        </div>
      )}

      {/* Live leadership broadcast banner (Curated only). Renders nothing when
          no covered leader is upcoming/live/recently-ended, so there is no
          empty strip or layout shift. Per-viewer on/off below. */}
      {showLiveBanner && <LiveBroadcastBanner />}

      <main className="curated-sheet max-w-[2200px] mx-auto px-3 py-2">
        {boardLayout.pageMode === "two" ? (
          /* 2-SECTION PAGE MODE: left pane (everything except Top Stories /
             Custom Feed, split into sub-columns) + right pane (Top Stories +
             Custom Feed). When no left-pane content is visible the left div is
             omitted entirely and the grid collapses to a single column. */
          <div
            ref={hasTwoColLeft ? mainGridRef : undefined}
            className={hasTwoColLeft
              ? "grid grid-cols-1 lg:relative lg:grid-cols-[var(--cur-cols)] gap-6 lg:gap-0"
              : "grid grid-cols-1"}
            style={
              hasTwoColLeft && twoColTemplate
                ? ({ "--cur-cols": twoColTemplate } as React.CSSProperties)
                : undefined
            }
          >
            {hasTwoColLeft && twoColBase && (
              <ColumnResizeHandles
                containerRef={mainGridRef}
                baseWeights={twoColBase}
                deltas={twoColDeltas}
                minPx={twoColMinPx}
                maxPx={twoColMaxPx}
                onChange={(d) => updateColumnWeights(twoColSig, d)}
              />
            )}
            {hasTwoColLeft && (
              <div className="lg:pr-5">{twoColLeft}</div>
            )}
            <div
              ref={middleColCallbackRef}
              className={`space-y-5 border-border order-first lg:order-none${hasTwoColLeft ? " lg:pl-5 lg:border-l" : ""}`}
              data-testid="region-two-col-right"
            >
              <div className="space-y-4" data-testid="section-top-stories">
                {renderTopStoriesSection(topStoriesEnlarged)}
              </div>
              {customFeedPlacement !== "off" &&
                renderMovableFeedLeft("customFeed")}
            </div>
          </div>
        ) : (
        <div
          ref={threeColBase ? mainGridRef : undefined}
          className={[
            "grid grid-cols-1 gap-6 lg:gap-0",
            threeColBase ? "lg:relative lg:grid-cols-[var(--cur-cols)]" : "lg:grid-cols-1",
          ].join(" ")}
          style={
            threeColBase && threeColTemplate
              ? ({ "--cur-cols": threeColTemplate } as React.CSSProperties)
              : undefined
          }
        >
          {threeColBase && (
            <ColumnResizeHandles
              containerRef={mainGridRef}
              baseWeights={threeColBase}
              deltas={threeColDeltas}
              minPx={threeColMinPx}
              maxPx={threeColMaxPx}
              onChange={(d) => updateColumnWeights(threeColSig, d)}
            />
          )}
          {/* LEFT COLUMN — omitted entirely when empty so it leaves no border
              gutter behind. Board position is the authority; visibility stays on
              each section's own on/off gate. */}
          {hasLeftContent && (
          <div className="space-y-5 lg:pr-5">
            {leftColNodes}
          </div>
          )}

          {/* MIDDLE COLUMN — border-x adapts: only draw the side that has a
              neighbour, so a missing left or right column never leaves a
              dangling border on the centre pane. */}
          <div
            ref={middleColCallbackRef}
            className={[
            "space-y-4 border-border order-first lg:order-none",
            hasLeftContent || hasRightContent ? "lg:px-5" : "",
            hasLeftContent ? "lg:border-l" : "",
            hasRightContent ? "lg:border-r" : "",
          ].filter(Boolean).join(" ")}>
            {/* Top Stories is LOCKED to the middle column (Task #322): it always
                renders here and has no on/off toggle on the board. */}
            <div className="space-y-4" data-testid="section-top-stories">
              {renderTopStoriesSection(topStoriesEnlarged)}
            </div>
          </div>

          {/* RIGHT REGION — omitted entirely when all social feeds are off and
              nothing sits in R2, so it leaves no empty gutter. When present:
              the R1 social bloc fills the column when r1FillColumn (nothing
              below), or scrolls normally otherwise. Abspos trick (see original
              comment) removes the bloc from intrinsic-sizing so the shared grid
              row is sized by left/middle only. */}
          {hasRightContent && <div ref={rightColCallbackRef} className={r1FillColumn ? "lg:relative" : "lg:pl-5"}>
            <div
              className={
                r1FillColumn
                  ? "lg:absolute lg:inset-0 lg:pl-5 lg:flex lg:flex-col"
                  : undefined
              }
            >
            {(() => {
              // Task #252 — the 3 / 2 / 1 column layout switcher drives both the
              // column arrangement and the per-mode avatar/text scale. All feeds
              // remain gated by the unified Configure Layout modal (showTruth /
              // showSecwar / showOsint / showPress). The 3/2/1 picker and every
              // feed toggle now live inside that one modal (Task #258 follow-up).
              const baseScale = SOCIAL_LAYOUT_SCALE[socialLayout];
              // Step up one level when the right column has been dragged wider
              // past the hysteresis threshold (three-column mode only).
              const scale: CuratedFeedScale =
                boardLayout.pageMode === "three" && rightSteppedUp && baseScale === "sm"
                  ? "md"
                  : baseScale;

              // The R1 social bloc is driven by the Configure Layout board's R1
              // lanes (Task #322 follow-up): each lane is one column, and a lane
              // holding more than one feed rotates through them (like the default
              // OSINT <-> Press column). A feed contributes a pane only when its
              // placement isn't "off"; feeds NOT owned by R1 fall back to the
              // left/right standalone columns above/below. Custom Feed is not
              // R1-rotatable this pass and keeps its own row.
              const paneFor = (key: MovableFeedKey): SocialPane | null => {
                if (movableFeedPlacements[key] === "off") return null;
                switch (key) {
                  case "truth":
                    return {
                      key: "truth",
                      title: "Truth Social",
                      tooltip: (
                        <SectionMethodologyTooltip
                          section="truth-social"
                          testId="tooltip-section-truth-social-methodology"
                        >
                          Posts from Truth Social, a platform used by U.S. political
                          figures including the President — a primary channel for
                          official statements and policy signals. Shown for situational
                          awareness; not fact-checked news.
                        </SectionMethodologyTooltip>
                      ),
                      node: renderTruthNode(scale),
                    };
                  case "secwar":
                    return {
                      key: "us-x",
                      title: "U.S. X Feed",
                      headerControl: usXFeedDropdown,
                      tooltip: (
                        <SectionMethodologyTooltip
                          section="x-feed"
                          testId="tooltip-section-us-x-methodology"
                        >
                          Posts from curated U.S. officials, senior military leaders,
                          and key national-security figures on X (formerly Twitter) — a
                          real-time window into official statements and developing
                          situations.
                        </SectionMethodologyTooltip>
                      ),
                      node: renderUsXNode(scale),
                    };
                  case "osint":
                    return {
                      key: "osint",
                      title: "OSINT X Feed",
                      headerControl: osintFeedDropdown,
                      tooltip: (
                        <SectionMethodologyTooltip
                          section="x-feed"
                          testId="tooltip-section-osint-methodology"
                        >
                          Posts from OSINT (Open-Source Intelligence) analysts, defense
                          military accounts, and combatant commands on X — early signals,
                          imagery, and situational awareness before major outlets publish.
                        </SectionMethodologyTooltip>
                      ),
                      node: renderOsintNode(scale),
                    };
                  case "press":
                    return {
                      key: "press",
                      title: "Press X Feed",
                      headerControl: pressFeedDropdown,
                      tooltip: (
                        <SectionMethodologyTooltip
                          section="x-feed"
                          testId="tooltip-section-press-methodology"
                        >
                          Posts from defense and national-security journalists,
                          correspondents, and major press outlets on X — reporter-level
                          alerts, breaking coverage, and story leads.
                        </SectionMethodologyTooltip>
                      ),
                      node: renderPressNode(scale),
                    };
                  case "firstAlert":
                    return {
                      key: "first-alert",
                      title: "DATAMINR",
                      tooltip: (
                        <SectionMethodologyTooltip
                          section="dataminr"
                          testId="tooltip-section-dataminr-r1-methodology"
                        >
                          DataMinr First Alert — an AI-powered early-warning service
                          that surfaces breaking events from open data, often before
                          traditional news outlets publish. Shown as attached context;
                          never forms or alters corroborated stories.
                        </SectionMethodologyTooltip>
                      ),
                      node: renderFirstAlertNode(),
                    };
                  default:
                    return null;
                }
              };

              // Preserve the historical per-feed section testids for static
              // columns so existing markup hooks keep resolving.
              const STATIC_TESTID: Record<string, string> = {
                truth: "section-truth-social",
                "us-x": "section-secwar",
                osint: "section-osint",
                press: "section-press",
                "first-alert": "section-first-alert",
              };

              type RenderColumn =
                | { kind: "static"; pane: SocialPane; testid: string }
                | { kind: "rotating"; panes: SocialPane[]; sectionTestId: string };
              const columns: RenderColumn[] = [];

              r1Lanes.forEach((lane, laneIdx) => {
                const lanePanes = lane
                  .map((k) => paneFor(k as MovableFeedKey))
                  .filter(Boolean) as SocialPane[];
                if (lanePanes.length === 0) return;
                if (lanePanes.length === 1) {
                  columns.push({
                    kind: "static",
                    pane: lanePanes[0],
                    testid:
                      STATIC_TESTID[lanePanes[0].key] ??
                      `section-social-${lanePanes[0].key}`,
                  });
                } else {
                  columns.push({
                    kind: "rotating",
                    panes: lanePanes,
                    sectionTestId: `section-social-rotating-${laneIdx}`,
                  });
                }
              });

              const renderedCols = columns.length;
              const gridColsClass =
                renderedCols >= 3
                  ? "md:grid-cols-3"
                  : renderedCols === 2
                    ? "md:grid-cols-2"
                    : "md:grid-cols-1";

              // No R1-owned social feeds — the bloc renders nothing. (Feeds may
              // be placed in the left column or off; the custom feed / DataMinr
              // standalone sections below still render if placed right.)
              if (columns.length === 0) {
                return null;
              }

              return (
                <div
                  className={`grid grid-cols-1 ${gridColsClass} gap-x-2 gap-y-6 ${
                    r1FillColumn
                      ? "items-start lg:items-stretch lg:grid-rows-1 lg:flex-1 lg:min-h-0"
                      : "items-start"
                  }`}
                >
                  {columns.map((col) => {
                    if (col.kind === "static") {
                      return (
                        <section
                          key={col.pane.key}
                          data-testid={col.testid}
                          className={
                            r1FillColumn ? "lg:h-full lg:flex lg:flex-col" : undefined
                          }
                        >
                          <SectionHeading
                            title={col.pane.title}
                            tooltip={col.pane.tooltip}
                            actions={col.pane.headerControl}
                          />
                          <div
                            className={`curated-scroll overflow-y-auto overflow-x-hidden pr-2 min-h-[240px] ${
                              r1FillColumn
                                ? "max-h-[480px] lg:max-h-none lg:flex-1 lg:min-h-0"
                                : "max-h-[480px]"
                            }`}
                          >
                            {col.pane.node}
                          </div>
                        </section>
                      );
                    }
                    return (
                      <RotatingSocialColumn
                        key={col.sectionTestId}
                        panes={col.panes}
                        sectionTestId={col.sectionTestId}
                        fill={r1FillColumn}
                      />
                    );
                  })}
                </div>
              );
            })()}
            {/* Board-driven content below the R1 social bloc (R2 slot). Same
                builders as the left column; POSITION from the board, VISIBILITY
                from each feed's on/off gate. */}
            {rightBelowBloc}
            </div>
          </div>}
        </div>
        )}
      </main>

      {/* Methodology link + feedback button — at the very bottom of the Curated view. */}
      <footer className="max-w-[2200px] mx-auto px-3 py-4 mt-2 border-t border-border flex flex-wrap items-center gap-4">
        <Link href="/curated/methodology">
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            data-testid="link-methodology"
          >
            METHODOLOGY
          </button>
        </Link>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => setFeedbackOpen(true)}
          data-testid="button-send-feedback"
        >
          FEEDBACK
        </button>
      </footer>

      <CuratedFeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />

      {/* CONFIGURE LAYOUT — the single place to turn every section on/off, set
          item counts, and choose the social feed column layout. Mirrors the page
          (top bar + three columns). Changes persist automatically. */}
      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent
          className="curated-surface bg-background text-foreground max-w-4xl w-[95vw] max-h-[85vh] flex flex-col p-0"
          data-testid="dialog-configure-layout"
        >
          <DialogHeader className="px-4 sm:px-6 py-4 border-b border-border shrink-0">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              {/* Brand mark on the left, mirroring the Curated page header
                  (same logo, same drop-shadow, large/prominent) so the dialog
                  reads as the same surface as the page. */}
              <div className="flex items-center gap-4 min-w-0">
                <img
                  src={mcopLogoWhite}
                  alt="MCOP"
                  className="h-20 w-auto shrink-0 [filter:drop-shadow(0_3px_4px_rgba(0,0,0,0.95))_drop-shadow(0_6px_12px_rgba(0,0,0,0.8))]"
                  data-testid="img-config-logo"
                />
                <div className="min-w-0">
                  <DialogTitle className="text-lg font-semibold">
                    Configure Layout
                  </DialogTitle>
                  <DialogDescription>
                    Drag sections between slots to arrange the board, turn them
                    on or off, and choose how many items each one shows. Changes
                    are saved automatically.
                  </DialogDescription>
                </div>
              </div>
              {/* Light/Dark theme switcher — lives in the Configure
                  Layout area so viewers can flip the curated view's theme. */}
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs font-medium text-muted-foreground">
                  Theme
                </span>
                <CuratedThemeSwitcher />
              </div>
              {/* Editor sign-in. Shown only to users the server does NOT already
                  recognize as an editor (canEdit === false) — e.g. a public
                  member (app-password login) who is on the editor allowlist but
                  hasn't done the Replit login yet. Triggers the Replit OAuth
                  flow; on return canEdit flips true and moderation controls
                  appear. Hidden once you're a recognized editor. */}
              {!canEdit && (
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto self-start shrink-0 gap-2"
                  onClick={() => {
                    window.location.href = "/api/login";
                  }}
                  data-testid="button-login-as-editor"
                >
                  <LogIn className="h-4 w-4" />
                  Log in as editor
                </Button>
              )}
            </div>
          </DialogHeader>

          <div className="overflow-x-hidden overflow-y-auto curated-scroll px-4 sm:px-6 py-4">
            {/* Drag-and-drop layout board (Task #322). Slot placements ARE the
                live layout: dragging a section between slots relocates it on the
                page (POSITION), persisted to its own localStorage key and read
                back here. Each card's on/off + count settings stay wired to the
                existing layout-config state (VISIBILITY). */}
            <CuratedLayoutBoard
              tickerMode={tickerMode}
              setTickerMode={setTickerMode}
              showTicker={showTicker}
              setShowTicker={setShowTicker}
              showSearchBar={showSearchBar}
              setShowSearchBar={setShowSearchBar}
              showMcopBot={showMcopBot}
              setShowMcopBot={setShowMcopBot}
              showLiveBanner={showLiveBanner}
              setShowLiveBanner={setShowLiveBanner}
              onResetDefaults={handleResetLayoutDefaults}
              showMcopHighlights={showMcopHighlights}
              setShowMcopHighlights={setShowMcopHighlights}
              showIeHighlights={showIeHighlights}
              setShowIeHighlights={setShowIeHighlights}
              showAerial={showAerial}
              setShowAerial={setShowAerial}
              showAerialDomestic={showAerialDomestic}
              setShowAerialDomestic={setShowAerialDomestic}
              aerialDomesticMax={aerialDomesticMax}
              setAerialDomesticMax={setAerialDomesticMax}
              showAerialIntl={showAerialIntl}
              setShowAerialIntl={setShowAerialIntl}
              aerialIntlMax={aerialIntlMax}
              setAerialIntlMax={setAerialIntlMax}
              showAerialTrending={showAerialTrending}
              setShowAerialTrending={setShowAerialTrending}
              showTopStories={showTopStories}
              setShowTopStories={setShowTopStories}
              showStateNarratives={showStateNarratives}
              setShowStateNarratives={setShowStateNarratives}
              showPreviewPane={showPreviewPane}
              setShowPreviewPane={setShowPreviewPane}
              topStoriesCount={topStoriesCount}
              setTopStoriesCount={setTopStoriesCount}
              storiesFeedCount={storiesFeedCount}
              setStoriesFeedCount={setStoriesFeedCount}
              isEditor={effectiveAccess}
              feeds={movableFeedDefs.map((f) => ({
                key: f.key,
                placement: f.placement,
                setPlacement: f.setPlacement,
                defaultColumn: f.defaultColumn,
              }))}
              socialLayout={socialLayout}
              setSocialLayout={setSocialLayout}
              hideRepostsSecwar={hideRepostsUsXFeed}
              setHideRepostsSecwar={setHideRepostsUsXFeed}
              hideRepostsOsint={hideRepostsOsintFeed}
              setHideRepostsOsint={setHideRepostsOsintFeed}
              hideRepostsPress={hideRepostsPressFeed}
              setHideRepostsPress={setHideRepostsPressFeed}
            />
          </div>

          <DialogFooter className="px-4 sm:px-6 py-3 border-t shrink-0">
            <Button
              variant="curated"
              onClick={() => setConfigOpen(false)}
              data-testid="button-config-done"
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CUSTOM FEED picker — "What do you want to see?" */}
      <Dialog open={customFeedDialogOpen} onOpenChange={setCustomFeedDialogOpen}>
        <DialogContent
          className="curated-surface bg-background text-foreground max-w-2xl w-[95vw] max-h-[85vh] flex flex-col p-0"
          data-testid="dialog-custom-feed"
        >
          <DialogHeader className="px-6 py-4 border-b shrink-0">
            <DialogTitle className="text-lg font-semibold">
              What do you want to see?
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              Tap a value to include it, tap again to exclude it (
              <Minus className="inline w-3 h-3 align-text-bottom" />), once more
              to clear. Counts update as you choose; a value showing{" "}
              <span className="font-semibold">0</span> has nothing right now —
              pick it anyway to watch for new stories.
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Signed in with Replit? Your saved views and Curated settings sync
              to your account and follow you across devices. Password-only
              visitors stay on this browser.
            </p>
          </DialogHeader>
          <div className="overflow-y-auto curated-scroll px-6 py-4 space-y-5">
            {/* Saved views — apply / rename / delete. */}
            {customFeedViews.length > 0 && (
              <div data-testid="group-custom-feed-saved-views">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  Saved Views
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {customFeedViews.map((view) => (
                    <div
                      key={view.id}
                      className="flex items-center rounded-md border border-border overflow-hidden"
                      data-testid={`saved-view-${view.id}`}
                    >
                      <button
                        type="button"
                        onClick={() => applyCustomFeedView(view)}
                        className="px-2.5 py-1 text-xs font-medium hover-elevate"
                        data-testid={`button-apply-view-${view.id}`}
                        title="Apply this view"
                      >
                        {view.name}
                      </button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 rounded-none"
                        onClick={() => {
                          const next = window.prompt("Rename view", view.name);
                          if (next != null) renameCustomFeedView(view.id, next);
                        }}
                        data-testid={`button-rename-view-${view.id}`}
                        title="Rename"
                      >
                        <Pencil className="w-3 h-3" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 rounded-none"
                        onClick={() => deleteCustomFeedView(view.id)}
                        data-testid={`button-delete-view-${view.id}`}
                        title="Delete"
                      >
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Time window — single-select recency threshold. */}
            <div data-testid="group-custom-feed-time">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Time window
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {customFeedTimeOptions.map((opt) => {
                  const on = customFeedSel.timeWindowHours === opt.hours;
                  const disabled = opt.count === 0 && !on;
                  return (
                    <Badge
                      key={opt.label}
                      variant={on ? "default" : "outline"}
                      className={`cursor-pointer gap-1 ${
                        on ? "bg-curated-accent text-white [border-color:hsl(var(--curated-accent))]" : ""
                      } ${disabled ? "opacity-40 pointer-events-none" : ""}`}
                      onClick={() =>
                        !disabled && setCustomFeedTimeWindow(opt.hours)
                      }
                      data-testid={`option-custom-feed-time-${opt.hours ?? "any"}`}
                    >
                      {on && <Check className="w-3 h-3" />}
                      {opt.label}
                      <span className="opacity-60">{opt.count}</span>
                    </Badge>
                  );
                })}
              </div>
            </div>

            {/* Keyword watchlist (Task #456) — ADDITIVE. Type words to ALSO pull
                in any story whose text contains them, even ones the normal
                ranking never showed. */}
            <div data-testid="group-custom-feed-keywords">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                Keyword watchlist
              </h4>
              <p className="text-[11px] text-muted-foreground mb-2">
                Add words to watch. Any story that mentions one shows up here —
                even stories that wouldn't normally make the cut.
              </p>
              <div className="flex gap-1.5 mb-2">
                <Input
                  value={customFeedKeywordInput}
                  onChange={(e) => setCustomFeedKeywordInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCustomFeedKeyword();
                    }
                  }}
                  placeholder="e.g. submarine, Taiwan, hypersonic…"
                  className="h-9"
                  data-testid="input-custom-feed-keyword"
                />
                <Button
                  variant="curated"
                  onClick={addCustomFeedKeyword}
                  disabled={customFeedKeywordInput.trim().length < 2}
                  data-testid="button-add-custom-feed-keyword"
                >
                  Add
                </Button>
              </div>
              {customFeedKeywords.length > 0 ? (
                <div
                  className="flex flex-wrap gap-1.5"
                  data-testid="list-custom-feed-keywords"
                >
                  {customFeedKeywords.map((k) => (
                    <Badge
                      key={k}
                      variant="secondary"
                      className="cursor-pointer gap-1"
                      onClick={() => removeCustomFeedKeyword(k)}
                      data-testid={`option-custom-feed-keyword-${k}`}
                    >
                      <Search className="w-3 h-3" />
                      {k}
                      <X className="w-3 h-3" />
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  No keywords yet.
                </p>
              )}
            </div>

            {/* Two captioned sections: about the story vs. who reported it. */}
            {CUSTOM_FEED_SECTIONS.map((section) => {
              const dims = CUSTOM_FEED_DIMENSIONS.filter(
                (d) => d.section === section.id,
              ).filter((d) => (customFeedOptions[d.key] ?? []).length > 0);
              if (dims.length === 0) return null;
              return (
                <div
                  key={section.id}
                  data-testid={`section-custom-feed-${section.id}`}
                >
                  <div className="text-xs font-semibold uppercase tracking-wider text-foreground/80 pb-1 mb-3 border-b border-border">
                    {section.label}
                  </div>
                  <div className="space-y-4">
                    {dims.map(({ key, label }) => {
                      const opts = customFeedOptions[key];
                      const sel = customFeedSel.facets[key];
                      const showSearch =
                        opts.length > CUSTOM_FEED_SEARCH_THRESHOLD;
                      const searchVal = customFeedSearch[key] ?? "";
                      const q = searchVal.trim().toLowerCase();
                      const filtered =
                        showSearch && q
                          ? opts.filter((o) =>
                              o.value.toLowerCase().includes(q),
                            )
                          : opts;
                      return (
                        <div
                          key={key}
                          data-testid={`group-custom-feed-${key}`}
                        >
                          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                            {label}
                          </h4>
                          {showSearch && (
                            <div className="relative mb-2">
                              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                              <Input
                                value={searchVal}
                                onChange={(e) =>
                                  setCustomFeedSearch((prev) => ({
                                    ...prev,
                                    [key]: e.target.value,
                                  }))
                                }
                                placeholder={`Filter ${label.toLowerCase()}…`}
                                className="h-8 pl-7 text-xs"
                                data-testid={`input-search-custom-feed-${key}`}
                              />
                            </div>
                          )}
                          <div className="flex flex-wrap gap-1.5">
                            {filtered.map(({ value, count }) => {
                              const isInc =
                                sel?.include.includes(value) ?? false;
                              const isExc =
                                sel?.exclude.includes(value) ?? false;
                              // Count 0 = nothing matches right now. Keep it
                              // dimmed but still SELECTABLE so a user can pick a
                              // value that isn't live yet and watch for it.
                              const dimmed = count === 0 && !isInc && !isExc;
                              return (
                                <Badge
                                  key={value}
                                  variant={isInc ? "default" : "outline"}
                                  className={`cursor-pointer gap-1 ${
                                    isInc
                                      ? "bg-curated-accent text-white [border-color:hsl(var(--curated-accent))]"
                                      : ""
                                  } ${
                                    isExc
                                      ? "border-destructive text-destructive line-through"
                                      : ""
                                  } ${dimmed ? "opacity-50" : ""}`}
                                  onClick={() => cycleCustomFeed(key, value)}
                                  data-testid={`option-custom-feed-${key}-${value}`}
                                  title={
                                    isInc
                                      ? "Included — tap to exclude"
                                      : isExc
                                        ? "Excluded — tap to clear"
                                        : "Tap to include"
                                  }
                                >
                                  {isInc && <Check className="w-3 h-3" />}
                                  {isExc && (
                                    <Minus className="w-3 h-3 no-underline" />
                                  )}
                                  {value}
                                  <span className="opacity-60 no-underline">
                                    {count}
                                  </span>
                                </Badge>
                              );
                            })}
                            {filtered.length === 0 && (
                              <span className="text-xs text-muted-foreground">
                                No matches.
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Explicit empty-state when the combination returns nothing. */}
            {customFeedActiveCount > 0 &&
              customFeedDisplayStories.length === 0 &&
              !keywordMatchesLoading && (
                <div
                  className="border border-border rounded-md p-4 text-center text-sm text-muted-foreground"
                  data-testid="empty-custom-feed-dialog"
                >
                  No stories match this combination. Loosen or clear a filter to
                  see results.
                </div>
              )}

            {/* Save the current selection as a named view. */}
            <div className="border-t border-border pt-4">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Save this view
              </h4>
              <div className="flex items-center gap-2">
                <Input
                  value={customFeedViewName}
                  onChange={(e) => setCustomFeedViewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveCustomFeedView();
                  }}
                  placeholder="Name this view (e.g. Iran Desk)"
                  className="h-8 text-xs"
                  data-testid="input-custom-feed-view-name"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={saveCustomFeedView}
                  disabled={
                    !customFeedViewName.trim() || customFeedSelCount === 0
                  }
                  data-testid="button-save-custom-feed-view"
                >
                  Save
                </Button>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 px-6 py-3 border-t shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={clearCustomFeedAll}
              disabled={customFeedActiveCount === 0}
              data-testid="button-reset-custom-feed"
            >
              Clear all
            </Button>
            <Button
              size="sm"
              variant="curated"
              onClick={() => setCustomFeedDialogOpen(false)}
              data-testid="button-done-custom-feed"
            >
              {customFeedActiveCount > 0
                ? `Show ${customFeedDisplayStories.length} ${customFeedDisplayStories.length === 1 ? "story" : "stories"}`
                : "Done"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {latestScrub && (
        <Dialog open={scrubViewerOpen} onOpenChange={setScrubViewerOpen}>
          <DialogContent
            className="curated-surface bg-background text-foreground border-2 border-yellow-500/50 max-w-5xl w-[95vw] h-[90vh] flex flex-col p-0 overflow-visible"
            onInteractOutside={(e) => e.preventDefault()}
            data-testid="dialog-ie-scrub-viewer"
          >
            <DialogHeader className="flex flex-row items-center justify-between gap-3 space-y-0 px-6 py-4 border-b shrink-0">
              <div className="flex items-center gap-3">
                <FileText className="w-6 h-6 text-primary" />
                <div>
                  <DialogTitle className="text-lg font-semibold" data-testid="text-ie-scrub-title">
                    Current News Scrub
                  </DialogTitle>
                  <p className="text-sm text-muted-foreground">
                    Current as of {(() => {
                      const d = new Date(latestScrub.caoDate);
                      const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
                      const dd = String(d.getDate()).padStart(2, "0");
                      const mon = months[d.getMonth()];
                      const yyyy = d.getFullYear();
                      const hh = String(d.getHours()).padStart(2, "0");
                      const mm = String(d.getMinutes()).padStart(2, "0");
                      return `${dd}${mon}${yyyy} ${hh}:${mm}`;
                    })()} — {latestScrub.filename}
                  </p>
                </div>
              </div>
              <a href={`/api/curated/news-scrub/${latestScrub.id}/download`} download>
                <Button variant="curated" data-testid="button-ie-scrub-download">
                  <Download className="w-4 h-4 mr-2" />
                  Download PDF
                </Button>
              </a>
            </DialogHeader>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {latestScrub.hasHtml && scrubHtmlData?.htmlContent ? (
                <div
                  className="news-scrub-viewer px-8 py-6 max-w-4xl mx-auto"
                  dangerouslySetInnerHTML={{ __html: scrubHtmlData.htmlContent }}
                  data-testid="ie-scrub-viewer-html"
                />
              ) : latestScrub.hasHtml && scrubHtmlLoading ? (
                <div className="flex items-center justify-center h-full gap-3">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  <span className="text-muted-foreground">Loading formatted content...</span>
                </div>
              ) : (
                <iframe
                  src={`/api/curated/news-scrub/${latestScrub.id}/download?inline=true`}
                  className="w-full h-full border-0"
                  title="News Scrub PDF Viewer"
                  data-testid="ie-scrub-viewer-iframe"
                />
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}

      <StoryDetailDialog
        story={selectedStory}
        onClose={() => setSelectedStory(null)}
        hasAccess={effectiveAccess}
        rankingCutoffs={rankingCutoffs}
        initialScrollTop={pendingStoryScroll}
        onScrollRestored={() => setPendingStoryScroll(null)}
        preventDismiss={tourOpen}
      />

      {/* State-controlled Narratives detail (Task #450) — the full per-country
          lens. Left/right selectors move across the countries the server
          surfaced today; clicking a row opens that article in the shared story
          dialog (openNarrative). Read-only, curated-lane only. */}
      {(() => {
        const list = stateNarrativeCountries;
        const idx = list.findIndex((c) => c.country === stateNarrativeDetail);
        const open = idx >= 0;
        const active = open ? list[idx] : null;
        const go = (delta: number) => {
          if (list.length === 0) return;
          const next = (idx + delta + list.length) % list.length;
          setStateNarrativeDetail(list[next].country);
        };
        return (
          <Dialog
            open={open}
            onOpenChange={(o) => !o && setStateNarrativeDetail(null)}
          >
            <DialogContent
              className="max-w-lg"
              data-testid="dialog-state-narrative-detail"
            >
              {active && (
                <>
                  <div className="flex items-center justify-between gap-2 pr-6">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => go(-1)}
                      disabled={list.length <= 1}
                      aria-label="Previous country"
                      data-testid="button-state-narrative-prev"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Megaphone className="h-4 w-4 shrink-0 text-curated-accent-strong" />
                      <span
                        className="text-sm font-bold uppercase tracking-wider truncate"
                        data-testid="text-state-narrative-country"
                      >
                        {active.country}
                      </span>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        Top {Math.min(5, active.items.length)} of {active.count}
                        {active.latestAt && ` · updated ${timeAgo(active.latestAt)}`}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => go(1)}
                      disabled={list.length <= 1}
                      aria-label="Next country"
                      data-testid="button-state-narrative-next"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                  <div
                    className="curated-scroll overflow-y-auto max-h-[60vh] space-y-1 mt-2"
                    data-testid="list-state-narrative-detail"
                  >
                    {active.items.slice(0, 5).map((s) => (
                      <button
                        key={s.id}
                        className="w-full text-left rounded-md p-2 hover-elevate"
                        onClick={() => {
                          setStateNarrativeDetail(null);
                          openNarrative(s);
                        }}
                        data-testid={`state-narrative-detail-${s.id}`}
                      >
                        <div className="flex items-center gap-x-1 text-[10px] text-curated-accent-strong font-mono mb-0.5 min-w-0 overflow-hidden">
                          <span className="shrink-0 whitespace-nowrap">
                            {timeAgo(s.articlePublishedAt || s.scrapedAt)}
                          </span>
                          <span className="shrink-0">·</span>
                          <span className="truncate">{s.source}</span>
                          {/* Dead-link overlay (Task #630) — same treatment as
                              the compact lens row. */}
                          {s.linkDead && (
                            <DeadLinkCue testId={`badge-state-narrative-detail-link-dead-${s.id}`} />
                          )}
                        </div>
                        <span className="block text-[13px] leading-tight line-clamp-3">
                          {s.title}
                        </span>
                        {/* CPC paywall-breaker + AI detail (Task #450 follow-up):
                            the full bullets here (the detail view has room), else
                            the stored lede. Same fields the cluster detail uses. */}
                        {s.summaryBullets && s.summaryBullets.length > 0 ? (
                          <ul
                            className="list-disc pl-5 mt-1 space-y-0.5 text-xs text-muted-foreground leading-snug"
                            data-testid={`list-state-narrative-detail-bullets-${s.id}`}
                          >
                            {s.summaryBullets.map((b, i) => (
                              <li key={i}>{b}</li>
                            ))}
                          </ul>
                        ) : (
                          s.summary && (
                            <div
                              className="text-xs text-muted-foreground leading-snug mt-1 line-clamp-3"
                              data-testid={`text-state-narrative-detail-lede-${s.id}`}
                            >
                              {s.summary}
                            </div>
                          )
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </DialogContent>
          </Dialog>
        );
      })()}
      <MCOPBotDialog open={mcopBotOpen} onOpenChange={setMcopBotOpen} curatedContext />
      <CuratedTourOpener
        open={openerOpen}
        onTakeTour={handleOpenerTakeTour}
        onSkip={handleOpenerSkip}
      />
      <CuratedTour
        open={tourOpen}
        onOpenChange={setTourOpen}
        onOpenSampleStory={() =>
          setSelectedStory((prev) => {
            // Keep any story the viewer already opened. Otherwise open the
            // FROZEN showcase story (curatedShowcaseStory.ts) so the tour's
            // scroll-through always walks a complete, multi-section, multi-angle
            // example (neutral lede, corroborated facts, attributed claims,
            // contributing sources, and state-media contrast). Live clusters
            // churn every pass, so the previous "richest live" pick was
            // inconsistent — sometimes a thin cluster, sometimes an over-merged
            // megacluster with no synthesized lede/facts.
            if (prev) return prev;
            return CURATED_SHOWCASE_STORY;
          })
        }
        onCloseSampleStory={() => setSelectedStory(null)}
        onOpenMethodology={() => setLocation("/curated/methodology")}
      />
    </div>
    </OutletIndexContext.Provider>
  );
}
