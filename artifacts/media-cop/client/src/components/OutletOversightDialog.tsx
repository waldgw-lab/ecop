import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { resolveOutletLogo } from "@/lib/outletLogos";
import {
  Shield, Loader2, ExternalLink, Search, Upload, RotateCw, RotateCcw, ChevronDown, ChevronRight, X, Eye, EyeOff, Pencil, Ban, Tags, Clock, AlertTriangle, Radar, RadioTower, Activity, CheckCircle2, HelpCircle, XCircle, Lock, Rss, Copy, Pause, Play, SlidersHorizontal, Gauge, History, Link2, Check, Undo2, MessageSquare, Trash2, Archive,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { WatchTopicManager } from "@/components/WatchTopicManager";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { OutletRegistry, ClassificationTopicProposal, CuratedLiveBroadcastFiring, CuratedOverrideEvent } from "@shared/schema";
import { LINK_MERGE_REASONS, SCORE_ADJUST_REASONS, LIVE_ALERT_REASONS } from "@shared/curatedReasonVocab";
import {
  DEFAULT_EVIDENCE_FILTERS,
  evidenceQueryParams,
  evidenceQueryString,
  reasonLabel,
  ACTION_FAMILY_LABELS,
  ALL_ACTION_FAMILIES,
  ACTION_KIND_LABELS,
  OUTCOME_LABELS,
  GROUPING_LABEL_LABELS,
  LEGACY_RULE_TYPE_LABELS,
  LEGACY_DISPOSITION_LABELS,
  DATE_WINDOW_PRESETS,
  type EvidenceFilterState,
  type EditorialEvidenceResponse,
  type EvidenceEpisode,
  type LegacyLearningResponse,
  type LegacyDisposition,
} from "@/lib/editorialEvidence";

// Reason key → human label lookup across both vocab sets (link/merge +
// P-score). Unknown keys fall back to the raw key text per the vocab contract.
const REASON_KEY_LABELS: Record<string, string> = Object.fromEntries(
  [...LINK_MERGE_REASONS, ...SCORE_ADJUST_REASONS, ...LIVE_ALERT_REASONS].map((r) => [r.key, r.label]),
);
import {
  deriveBehavior,
  SOURCE_IDENTIFIERS,
  SOURCE_IDENTIFIER_LABELS,
  OTHER_SOURCE_TYPES,
  OTHER_SOURCE_TYPE_LABELS,
  OWNERSHIP_CATEGORIES,
  type BehaviorResult,
  type SourceIdentifier,
} from "@shared/outletRegistry";
import { findApprovedSocialAccountsForRegistryIdentity } from "@shared/socialAccountCatalog";

// Scoring & Relevance oversight tab (Task #622) — shape returned by
// /api/team/scoring-relevance. Read-only; mirrors the live constants/prompts.
interface PriorityBand {
  min: number;
  max: number;
  label: string;
  example?: string;
  // Severity tone derived server-side by ladder POSITION (top = most severe),
  // so the UI colors each band without hard-coding numeric cutoffs that could
  // drift from the real band ranges.
  tone?: "critical" | "high" | "moderate" | "low" | "minimal";
}
interface ScoringGate {
  key: string;
  label: string;
  value: number;
  description: string;
}
interface RuleChangeLogEntry {
  date: string;
  rule: string;
  change: string;
  reason: string;
}
interface ScoringCallSite {
  key: string;
  pipeline: string;
  fn: string;
  feeds: string;
  honorsActiveRubric: boolean;
  rubric: "legacy" | "new" | "other";
}
// Task #678 — an APPROVED learned scoring cap currently enforced in the curated
// lane (mined from editors repeatedly hiding/down-pinning the AI's high score).
interface LearnedScoringCap {
  outlet: string;
  category: string;
  cap: number | null;
  evidenceCount: number;
  decidedBy: string | null;
  decidedAt: string | null;
}
// Task #1093 — the live CURRENT CONTEXT block appended to the analyzer prompt
// at call time (today's date + auto-derived strategic picture).
interface StrategicContextSnapshot {
  enabled: boolean;
  dateLine: string;
  source: "auto" | "date-only" | "disabled";
  themes: Array<{ tag: string; count: number }>;
  topHeadlines: Array<{ title: string; score: number }>;
  adminNote: string | null;
  block: string;
  generatedAt: string;
}
interface ScoringRelevanceResponse {
  activeRubric: "legacy" | "new";
  priorityBands: PriorityBand[];
  scoringCallSites: ScoringCallSite[];
  relevanceGate: { summary: string; activeRubric: string };
  changelog: RuleChangeLogEntry[];
  gates: ScoringGate[];
  learnedScoringCaps?: LearnedScoringCap[];
  currentContext?: StrategicContextSnapshot | null;
  scoreDistribution?: {
    windowDays: number;
    totalScored: number;
    bands: Array<{ min: number; max: number; count: number }>;
    topValues: Array<{ score: number; count: number; sharePct: number }>;
    humanOverrides: number;
    unscoredFallback: number;
    otherScoreSources?: number;
    generatedAt: string;
  } | null;
  // Task #1094 — watch-topic steering cross-reference (curated-only nudges on
  // top of the base ladder), incl. the live steering toggle state.
  watchSteering?: {
    scope: string;
    mainFeedEnabled: boolean;
    enabled: boolean;
    note: string;
    floors: { weak: number; standard: number; strong: number };
    boosts: { weak: number; standard: number; strong: number };
    cap: number;
    rescueBudget: { perPass: number; perTopic: number };
  };
}

// Severity tone -> Tailwind classes for the priority-band ladder. Keyed by the
// server-derived `tone` (ladder position) so recoloring can never desync from
// the numeric ranges. Falls back to a numeric bucket if tone is absent.
const PRIORITY_BAND_TONE_CLASSES: Record<string, string> = {
  critical: "bg-red-500/15 border-red-500/40 text-red-600 dark:text-red-400",
  high: "bg-orange-500/15 border-orange-500/40 text-orange-600 dark:text-orange-400",
  moderate: "bg-yellow-500/15 border-yellow-500/40 text-yellow-700 dark:text-yellow-400",
  low: "bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400",
  minimal: "bg-muted border-border text-muted-foreground",
};

// Editor-override learning log (Task #540) — shapes returned by
// /api/curated/override-log and .../brief.
interface OverrideReportCount { name: string; count: number; }
interface OverrideReport {
  windowDays: number;

  totalEvents: number;

  byAction: Record<string, number>;

  topSuppressedOutlets: OverrideReportCount[];

  topBoostedOutlets: OverrideReportCount[];

  topRelabeledFromTopic: OverrideReportCount[];

  topRegions: OverrideReportCount[];

  topCountries: OverrideReportCount[];

  pinSummary: { pinnedUp: number; pinnedDown: number; avgDelta: number };

  scoreConflicts: {
    scoreThreshold: number;
    highScoreHides: number;
    lowScoreBoosts: number;
    topHighScoreHideOutlets: OverrideReportCount[];
    topLowScoreBoostOutlets: OverrideReportCount[];
  };
  // Clustering-behavior changes (manual link/merge/unlink) — a distinct category
  // from the scoring/relevance signals above. Optional for backward-compat.

  clusteringChanges?: {
    total: number;
    links: number;
    merges: number;
    unlinks: number;
  };

  steering?: {
    exactCorrelated: number;
    uncorrelated: number;
    priorityBoosted: number;
    boloRescued: number;
    usImplicationAdjusted: number;
    nonSteered: number;
    byAction: Record<string, number>;
    byTopic: Record<string, number>;
  };

  editorialQuality?: Array<{
    action: string;
    count: number;
    distinctStories: number;
    reasons: OverrideReportCount[];

  }>;
}
interface OverrideLogResponse {
  report: OverrideReport;
  recent: CuratedOverrideEvent[];
  capturePaused: boolean;
  capturePausedBy: string | null;
  capturePausedAt: string | null;
  acknowledgedAt: string | null;
}
// Human-readable labels for the override action codes captured server-side.
const OVERRIDE_ACTION_LABELS: Record<string, string> = {
  "hide-story": "Hide story",
  "hide-image": "Hide image",
  "priority-override": "Priority pin",
  "classification": "Re-label",
  "replace-link": "Replace link",
  "replace-image": "Replace image",
  "upload-image": "Upload image",
  "outlet-block": "Block outlet",
  "outlet-unblock": "Unblock outlet",
  "manual-link": "Link stories",
  "manual-merge": "Merge stories",
  "manual-unlink": "Unlink stories",
  "content-kind-mark": "Content-kind mark",
  "content-kind-clear": "Content-kind cleared",
  "live-alert-hide": "Hide Live Watch alert",
  "live-alert-restore": "Restore Live Watch alert",
  "live-alert-edit": "Correct Live Watch alert",
};

type LiveAlertState = "upcoming" | "live" | "recently_ended";
type LiveAlertStatus = {
  state: LiveAlertState;
  leader: string;
  title: string;
  watchUrl: string;
  startsAt?: string;
  since?: string;
  endsAt?: string;
};
type ModeratedLiveFiring = CuratedLiveBroadcastFiring & {
  eventKey: string;
  moderation: {
    eventKey: string;
    suppressed: boolean;
    overrides: Partial<LiveAlertStatus>;
    updatedBy: string;
    updatedAt: string;
  } | null;
  effectiveStatus: LiveAlertStatus | null;
  isCurrentBannerEvent: boolean;
};
type LiveAlertMutationResult = {
  firingId: string;
  selectedEvent: {
    eventKey: string;
    state: LiveAlertState;
    leader: string;
    title: string;
    watchUrl: string;
    startsAt: string | null;
    firstObservedAt: string;
    endedAt: string | null;
    source: string | null;
  };
  isCurrentBannerEvent: boolean;
  activeBanner: {
    eventKey: string | null;
    status: LiveAlertStatus | null;
    lastComputed: number | null;
  };
};

const LIVE_ALERT_STATE_LABELS: Record<LiveAlertState, string> = {
  upcoming: "Starting soon",
  live: "LIVE",
  recently_ended: "Recently ended",
};

function formatLiveAlertTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function dateTimeLocalValue(value: string | Date | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function dateTimeIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Read-only vocabulary-drift surface (Task #351) — server-aggregated catch-all
// cluster shape returned by /api/team/classification-topics.
interface CatchAllTopicCluster {
  category: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  sampleTitles: string[];
}
interface ClassificationTopicsResponse {
  proposals: ClassificationTopicProposal[];
  catchAllClusters: CatchAllTopicCluster[];
  windowHours: number;
}

// Field vocabularies — kept in sync with the seed + reference dataset.
const FACTUALITY = ["very-high", "high", "mixed", "low", "very-low"];
const REGIONS = ["North America", "Europe", "Asia", "Middle East", "Africa", "South America", "Oceania"];

// Descriptive fields the oversight UI can still override, with their editor
// config. The new labeling model (Source Identifier, Other Source Type,
// Ownership, Blocked) is rendered separately above. `role` is DERIVED by the
// trust engine from Source Identifier + Other Source Type + factuality +
// blocked, so it is not editable here. The legacy Character / State-controlled
// / Bias fields have been removed — they are superseded by the new model.
// Factuality remains because it still feeds the derived role.
const OVERRIDE_FIELDS: { key: string; label: string; options?: string[]; kind: "select" | "text" | "bool" }[] = [
  { key: "factuality", label: "Factuality", options: FACTUALITY, kind: "select" },
  { key: "originCountry", label: "Origin country", kind: "text" },
  { key: "originRegion", label: "Origin region", options: REGIONS, kind: "select" },
];

type Provenance = Record<string, { source: string; at: string }>;

// Curated editor-update audit trail row (Task #430) — one manual link/merge
// action from /api/curated/manual-links.
interface ManualLinkRow {
  id: string;
  memberUrls: string[];
  label: string | null;
  kind: "link" | "merge";
  createdBy: string | null;
  aiVerdict: "concur" | "object" | "skipped";
  aiReasoning: string | null;
  overrodeAi: boolean;
  status: "active" | "revoked";
  createdAt: string;
  updatedAt: string;
}

// Read-only Coverage + Freshness + Pipeline Health report (Task #352, #400).
// As of #400 the Coverage tab shows the FULL roster (not just exceptions): every
// configured feed, every confirmed outlet, every source-resolution group — with
// the problem rows flagged — plus a read-only main-feed Pipeline Health audit.
interface CoverageGroup {
  key: string;
  domain: string | null;
  status: "unresolved" | "parent-fallback" | "resolved";
  matchedDomain: string | null;
  matchedOutlet: string | null;
  count: number;
  sampleSources: string[];
  sampleUrls: string[];
}
interface FreshnessOutlet {
  id: string;
  canonicalName: string;
  logoSlug: string | null;
  logoUrl: string | null;
  logoBrandColor: string | null;
  logoObjectFit: string | null;
  factuality: string | null;
  sourceIdentifier: string | null;
  lastEnrichedAt: string | null;
  freshestAt: string | null;
  stale: boolean;
  /** True when stale for structural reasons — no entry in the reference dataset,
   *  so the enrichment cron will never fill this outlet. Shown separately from
   *  genuinely-overdue outlets that the next enrichment pass will repair. */
  noReferenceData?: boolean;
  managedFields: { field: string; at: string | null }[];
}
interface ConfiguredFeed {
  name: string;
  kind: "feed" | "web";
  registered: boolean;
  urls: string[];
  itemCount: number;
  delivered: boolean;
}
type PipelineStatus = "healthy" | "degraded" | "broken" | "indeterminate";
interface PipelineVerdict {
  key: string;
  name: string;
  status: PipelineStatus;
  summary: string;
  runtimeSignal: string;
  tableSignal: string;
  evidence: string[];
  operatorAlert?: {
    kind: "warning";
    message: string;
  };
  lastSuccessAt: string | null;
}
type MeltwaterStatus = "healthy" | "throttled" | "stale" | "error" | "not-run";
interface MeltwaterHealth {
  status: MeltwaterStatus;
  summary: string;
  lastRunAt: string | null;
  lastRunAgeMs: number | null;
  outcome: string | null;
  ingested: number;
  skipped: number;
  dayRemaining: number | null;
  dayLimit: number | null;
  dayResetAt: string | null;
  minuteRemaining: number | null;
  isDegraded: boolean;
  quotaWarning: boolean;
  overflow: boolean;
}
interface MeltwaterSearchVerdictItem {
  label: string;
  displayName: string;
  cadenceLabel: string;
  staleThresholdMs: number;
  health: MeltwaterHealth;
}
interface MeltwaterCombinedQuota {
  totalDayRemaining: number | null;
  dayLimit: number | null;
  searchesWithTelemetry: number;
  searchCount: number;
  partial: boolean;
  warningFloor: number;
  belowFloor: boolean;
}
interface MeltwaterMultiHealth {
  searches: MeltwaterSearchVerdictItem[];
  aggregate: { isDegraded: boolean; degradedCount: number; worstStatus: MeltwaterStatus };
  combinedQuota?: MeltwaterCombinedQuota;
}
type FeedOutcome = "healthy" | "empty" | "error";
interface RssFeedHealthRow {
  url: string;
  sourceName: string;
  scope: "rss-monitor" | "warfighter";
  lastOutcome: FeedOutcome;
  lastDetail: string | null;
  consecutiveUnhealthy: number;
  streakKind: "empty" | "error" | "mixed" | null;
  recent: FeedOutcome[];
  lastHealthyAt: string | null;
  lastSeenAt: string;
  totalCycles: number;
  stale: boolean;
}
interface RssFeedHealth {
  feeds: RssFeedHealthRow[];
  total: number;
  stale: number;
}
interface IntakeTelemetryRow {
  id: number;
  sourceName: string;
  lastLabel: string;
  lastRunAt: string;
  fetched: number;
  kept: number;
  aged: number;
  dupInPass: number;
  ingested: number;
  dropInvalid: number;
  dropDupUrl: number;
  dropDupBatch: number;
  dropRelevanceRejected: number;
  dropRelevanceFinance: number;
  dropGateUnscored: number;
  dropFuzzyDup: number;
  dropBlocked: number;
  invalidOnlyStreak: number;
  // Honest-funnel fields (Task #1114).
  deferred: number;
  fetchFailures: number;
  lastFetchError: string | null;
  admissionPending: boolean;
  updatedAt: string;
}
interface RelayOutageReport {
  active: boolean;
  heartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  thresholdMs: number;
  fallbackLastRunAt: string | null;
  fallbackFresh: boolean;
}
interface CoverageReport {
  params: { hours: number; staleDays: number };
  relayOutage?: RelayOutageReport | null;
  feeds: ConfiguredFeed[];
  outlets: FreshnessOutlet[];
  sources: CoverageGroup[];
  pipeline: PipelineVerdict[];
  meltwater: MeltwaterMultiHealth;
  rssFeedHealth: RssFeedHealth;
  intakeTelemetry?: IntakeTelemetryRow[];
  summary: {
    feeds: { total: number; silent: number };
    outlets: { total: number; stale: number };
    sources: { total: number; flagged: number };
    pipeline: Record<PipelineStatus, number>;
    meltwater: { degraded: number };
    rssFeedHealth: { total: number; stale: number };
  };
  scanned: number;
  configuredCount: number;
}

// Display-only roster name (registry display names task). Handle-keyed rows
// carry a seeded human-readable displayName; render it with the @handle
// appended so "Osint613" reads "Open Source Intel (@Osint613)". Rows without a
// displayName (proper outlet names) render exactly as before. Never used for
// resolution/tiering/Coverage matching — those stay on canonicalName/aliases.
function outletDisplayName(row: OutletRegistry): string {
  const display = (row as { displayName?: string | null }).displayName?.trim();
  if (!display) return row.canonicalName;
  if (display === row.canonicalName) return display;
  return `${display} (@${row.canonicalName})`;
}

function provenanceLabel(row: OutletRegistry, field: string): string {
  const overrides = (row.manualOverrides ?? {}) as Record<string, unknown>;
  if (field in overrides) {
    const p = (row.enrichmentProvenance as Provenance)?.[field];
    return p ? `Manual override · ${p.source.replace(/^manual:/, "")}` : "Manual override";
  }
  const p = (row.enrichmentProvenance as Provenance)?.[field];
  if (!p) return "Curated seed";
  if (p.source === "seed") return "Curated seed";
  return `${p.source} · ${new Date(p.at).toLocaleDateString()}`;
}

// Human-readable label for the derived behavior class/label pair.
function behaviorLabel(b: BehaviorResult): string {
  if (b.blocked) return "Blocked";
  if (b.cls === "corroborating") return "Corroborating";
  if (b.cls === "anchor-only") return b.label === "primary" ? "Primary (anchor)" : "Contrast (anchor-only)";
  return "Attach-only";
}

function behaviorVariant(b: BehaviorResult): "default" | "secondary" | "destructive" | "outline" {
  if (b.blocked) return "destructive";
  if (b.cls === "corroborating") return "default";
  if (b.cls === "anchor-only" && b.label === "primary") return "secondary";
  return "outline";
}

function OutletRow({ row, allRows }: { row: OutletRegistry; allRows: OutletRegistry[] }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [logoUrl, setLogoUrl] = useState("");
  const [applyingUrl, setApplyingUrl] = useState(false);

  const overrides = (row.manualOverrides ?? {}) as Record<string, unknown>;

  const saveMutation = useMutation({
    mutationFn: async (changes: Record<string, unknown>) => {
      return apiRequest("PATCH", `/api/team/outlet-registry/${row.id}/overrides`, { overrides: changes });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/team/outlet-registry"] });
      setDraft({});
      toast({ title: "Override saved", description: row.canonicalName });
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const clearMutation = useMutation({
    mutationFn: async (field: string) => {
      return apiRequest("DELETE", `/api/team/outlet-registry/${row.id}/overrides/${field}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/team/outlet-registry"] });
      toast({ title: "Override cleared" });
    },
    onError: (e: Error) => toast({ title: "Clear failed", description: e.message, variant: "destructive" }),
  });

  async function uploadLogo(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("logo", file);
      const res = await fetch(`/api/team/outlet-registry/${row.id}/logo`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) throw new Error(await res.text());
      queryClient.invalidateQueries({ queryKey: ["/api/team/outlet-registry"] });
      queryClient.invalidateQueries({ queryKey: ["/api/curated/outlets"] });
      toast({ title: "Logo uploaded", description: row.canonicalName });
    } catch (e) {
      toast({ title: "Upload failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  async function applyLogoUrl() {
    const url = logoUrl.trim();
    if (!url) return;
    setApplyingUrl(true);
    try {
      const res = await fetch(`/api/team/outlet-registry/${row.id}/logo-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        credentials: "include",
      });
      if (!res.ok) throw new Error(await res.text());
      queryClient.invalidateQueries({ queryKey: ["/api/team/outlet-registry"] });
      queryClient.invalidateQueries({ queryKey: ["/api/curated/outlets"] });
      toast({ title: "Logo set from URL", description: row.canonicalName });
      setLogoUrl("");
    } catch (e) {
      toast({ title: "Set from URL failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setApplyingUrl(false);
    }
  }

  function handleLogoPaste(e: React.ClipboardEvent) {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItem = items.find((it) => it.type.startsWith("image/"));
    if (!imageItem) {
      toast({
        title: "No image in clipboard",
        description: "Copy an image first, then paste here.",
        variant: "destructive",
      });
      return;
    }
    const blob = imageItem.getAsFile();
    if (!blob) return;
    e.preventDefault();
    const ext = imageItem.type.split("/")[1] || "png";
    uploadLogo(new File([blob], `pasted-logo.${ext}`, { type: imageItem.type }));
  }

  const currentValue = (field: string): unknown =>
    field in draft ? draft[field] : (row as Record<string, unknown>)[field];

  const hasChanges = Object.keys(draft).length > 0;
  const confirmed = row.confirmationStatus === "confirmed";

  // Live-derived behavior from the current draft + persisted values. Mirrors the
  // server trust engine so the admin sees exactly what the labeling produces.
  const sourceIdentifier = (currentValue("sourceIdentifier") as string) || "other";
  const ownership = (currentValue("ownership") as string[] | undefined) ?? [];
  const blocked = !!currentValue("blocked");
  const behavior = deriveBehavior({
    sourceIdentifier,
    otherSourceType: (currentValue("otherSourceType") as string) ?? null,
    factuality: (currentValue("factuality") as string) ?? null,
    blocked,
  });

  // Curated-only (Task #530): DISPLAY-ONLY label, derived server-side from feed
  // wiring (outlet has a curated ingestion path but no main-feed path). Not an
  // admission gate, not editable.
  const curatedOnly = !!(row as { curatedOnly?: boolean }).curatedOnly;

  // Advisory (Task #531): warn when blocking a Curated-only outlet that is the
  // ONLY remaining Curated source for its origin country/region — blocking it
  // would leave a coverage blind spot. Purely advisory; never prevents the block.
  const areaKind: "country" | "region" | null = row.originCountry?.trim()
    ? "country"
    : row.originRegion?.trim()
      ? "region"
      : null;
  const areaVal =
    areaKind === "country"
      ? (row.originCountry ?? "").trim()
      : areaKind === "region"
        ? (row.originRegion ?? "").trim()
        : "";
  const otherActiveCuratedInArea = areaKind
    ? allRows.filter((r) => {
        if (r.id === row.id) return false;
        if (!(r as { curatedOnly?: boolean }).curatedOnly) return false;
        if ((r as Record<string, unknown>).blocked === true) return false;
        const v = ((areaKind === "country" ? r.originCountry : r.originRegion) ?? "").trim();
        return !!v && v === areaVal;
      }).length
    : 0;
  const isSoleCuratedSourceForArea = curatedOnly && !!areaKind && otherActiveCuratedInArea === 0;

  function toggleOwnership(cat: string) {
    const next = ownership.includes(cat)
      ? ownership.filter((o) => o !== cat)
      : ownership.length >= 3
        ? ownership // cap at 3
        : [...ownership, cat];
    setDraft((d) => ({ ...d, ownership: next }));
  }

  return (
    <div className="rounded-md border" data-testid={`row-outlet-${row.id}`}>
      <div
        className="flex items-center gap-3 p-3 hover-elevate cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
        data-testid={`button-expand-outlet-${row.id}`}
      >
        {expanded ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
        {resolveOutletLogo(row) ? (
          <img src={resolveOutletLogo(row)} alt={row.canonicalName} className="h-8 w-8 rounded-md object-contain shrink-0 bg-white" />
        ) : (
          <div className="h-8 w-8 rounded-md bg-muted text-muted-foreground flex items-center justify-center text-[10px] font-bold shrink-0">
            {(row.canonicalName || "?").slice(0, 2).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate" data-testid={`text-outlet-name-${row.id}`}>{outletDisplayName(row)}</div>
          <div className="text-xs text-muted-foreground truncate">
            {SOURCE_IDENTIFIER_LABELS[sourceIdentifier as SourceIdentifier] ?? sourceIdentifier}{row.originCountry ? ` · ${row.originCountry}` : ""}{row.factuality ? ` · ${row.factuality}` : ""}
          </div>
        </div>
        <Badge variant={behaviorVariant(behavior)} className="shrink-0" data-testid={`badge-role-${row.id}`}>
          {behaviorLabel(behavior)}
        </Badge>
        {curatedOnly && !blocked && (
          <Badge variant="secondary" className="shrink-0 gap-1" data-testid={`badge-curated-only-${row.id}`}>
            <Lock className="w-3 h-3" />
            Curated only
          </Badge>
        )}
        {ownership.includes("State-controlled") && <Badge variant="outline" className="shrink-0">State</Badge>}
        <Badge
          variant={confirmed ? "default" : "secondary"}
          className="shrink-0"
          data-testid={`badge-confirm-${row.id}`}
          title={
            confirmed
              ? "Enrichment-confirmed: this outlet's registry metadata (origin, factuality, ownership) has been verified by an enrichment pass. Does not affect its admission role."
              : "Not yet enrichment-confirmed: registry metadata is still seed/default and hasn't been verified by an enrichment pass. Does not affect its admission role."
          }
        >
          {confirmed ? "Enrichment-confirmed" : "Enrichment-pending"}
        </Badge>
      </div>

      {expanded && (
        <div className="border-t p-3 space-y-3" data-testid={`panel-outlet-${row.id}`}>
          {/* Derived role banner */}
          <div className="rounded-md border p-3 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium">Derived role</span>
              <Badge variant={behaviorVariant(behavior)} data-testid={`badge-derived-role-${row.id}`}>
                {behaviorLabel(behavior)}
              </Badge>
            </div>
            <div className="text-[11px] text-muted-foreground" data-testid={`text-derived-reason-${row.id}`}>
              {behavior.reason}
            </div>
          </div>

          {/* Trust-engine labeling fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">Source Identifier</span>
                {"sourceIdentifier" in overrides && (
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs"
                    onClick={() => clearMutation.mutate("sourceIdentifier")}
                    data-testid={`button-clear-sourceIdentifier-${row.id}`}>
                    <X className="w-3 h-3 mr-1" /> Clear
                  </Button>
                )}
              </div>
              <Select
                value={sourceIdentifier}
                onValueChange={(v) => setDraft((d) => ({ ...d, sourceIdentifier: v }))}
              >
                <SelectTrigger className="h-9" data-testid={`select-sourceIdentifier-${row.id}`}>
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {SOURCE_IDENTIFIERS.map((o) => (
                    <SelectItem key={o} value={o}>{SOURCE_IDENTIFIER_LABELS[o]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="text-[10px] text-muted-foreground">{provenanceLabel(row, "sourceIdentifier")}</div>
            </div>

            {/* Other Source Type — only when identifier is "other" */}
            {sourceIdentifier === "other" && (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">Other Source Type</span>
                  {"otherSourceType" in overrides && (
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs"
                      onClick={() => clearMutation.mutate("otherSourceType")}
                      data-testid={`button-clear-otherSourceType-${row.id}`}>
                      <X className="w-3 h-3 mr-1" /> Clear
                    </Button>
                  )}
                </div>
                <Select
                  value={(currentValue("otherSourceType") as string) ?? ""}
                  onValueChange={(v) => setDraft((d) => ({ ...d, otherSourceType: v }))}
                >
                  <SelectTrigger className="h-9" data-testid={`select-otherSourceType-${row.id}`}>
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    {OTHER_SOURCE_TYPES.map((o) => (
                      <SelectItem key={o} value={o}>{OTHER_SOURCE_TYPE_LABELS[o]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="text-[10px] text-muted-foreground">{provenanceLabel(row, "otherSourceType")}</div>
              </div>
            )}

            {OVERRIDE_FIELDS.map((f) => {
              const overridden = f.key in overrides;
              const val = currentValue(f.key);
              return (
                <div key={f.key} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{f.label}</span>
                    {overridden && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                        onClick={() => clearMutation.mutate(f.key)}
                        data-testid={`button-clear-${f.key}-${row.id}`}
                      >
                        <X className="w-3 h-3 mr-1" /> Clear
                      </Button>
                    )}
                  </div>
                  {f.kind === "select" && (
                    <Select
                      value={(val as string) ?? ""}
                      onValueChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                    >
                      <SelectTrigger className="h-9" data-testid={`select-${f.key}-${row.id}`}>
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        {(f.options ?? []).map((o) => (
                          <SelectItem key={o} value={o}>{o}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {f.kind === "text" && (
                    <Input
                      className="h-9"
                      value={(val as string) ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      data-testid={`input-${f.key}-${row.id}`}
                    />
                  )}
                  {f.kind === "bool" && (
                    <Select
                      value={val ? "true" : "false"}
                      onValueChange={(v) => setDraft((d) => ({ ...d, [f.key]: v === "true" }))}
                    >
                      <SelectTrigger className="h-9" data-testid={`select-${f.key}-${row.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="false">No</SelectItem>
                        <SelectItem value="true">Yes</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                  <div className="text-[10px] text-muted-foreground">{provenanceLabel(row, f.key)}</div>
                </div>
              );
            })}
          </div>

          {/* Ownership multi-select (max 3) */}
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">Ownership <span className="text-muted-foreground">(up to 3 — independent ownership strengthens corroboration)</span></span>
              {"ownership" in overrides && (
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs"
                  onClick={() => clearMutation.mutate("ownership")}
                  data-testid={`button-clear-ownership-${row.id}`}>
                  <X className="w-3 h-3 mr-1" /> Clear
                </Button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {OWNERSHIP_CATEGORIES.map((cat) => {
                const selected = ownership.includes(cat);
                const atCap = !selected && ownership.length >= 3;
                return (
                  <Badge
                    key={cat}
                    variant={selected ? "default" : "outline"}
                    className={`cursor-pointer ${atCap ? "opacity-40" : ""}`}
                    onClick={() => { if (!atCap) toggleOwnership(cat); }}
                    data-testid={`chip-ownership-${cat}-${row.id}`}
                  >
                    {cat}
                  </Badge>
                );
              })}
            </div>
            <div className="text-[10px] text-muted-foreground">{provenanceLabel(row, "ownership")}</div>
          </div>

          {/* Block toggle */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
            <div className="min-w-0">
              <div className="text-xs font-medium flex items-center gap-1"><Ban className="w-3 h-3" /> Blocked</div>
              <div className="text-[10px] text-muted-foreground">Hard-excluded from every surface, including Curated View.</div>
              <div className="text-[10px] text-muted-foreground">{provenanceLabel(row, "blocked")}</div>
            </div>
            <div className="flex items-center gap-2">
              {"blocked" in overrides && (
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs"
                  onClick={() => clearMutation.mutate("blocked")}
                  data-testid={`button-clear-blocked-${row.id}`}>
                  <X className="w-3 h-3 mr-1" /> Clear
                </Button>
              )}
              <Select
                value={blocked ? "true" : "false"}
                onValueChange={(v) => setDraft((d) => ({ ...d, blocked: v === "true" }))}
              >
                <SelectTrigger className="h-9 w-28" data-testid={`select-blocked-${row.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="false">Active</SelectItem>
                  <SelectItem value="true">Blocked</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {blocked && isSoleCuratedSourceForArea && (
              <div
                className="basis-full flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-400"
                role="alert"
                data-testid={`warn-sole-curated-${row.id}`}
              >
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>
                  This is the only Curated source for {areaVal}. Blocking it leaves no
                  Curated coverage for {areaVal} (outside manual submissions).
                </span>
              </div>
            )}
          </div>

          <div className="flex flex-nowrap items-center gap-2">
            <Button
              size="sm"
              className="shrink-0"
              disabled={!hasChanges || saveMutation.isPending}
              onClick={() => saveMutation.mutate(draft)}
              data-testid={`button-save-overrides-${row.id}`}
            >
              {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Save overrides
            </Button>
            {hasChanges && (
              <Button size="sm" variant="ghost" className="shrink-0" onClick={() => setDraft({})} data-testid={`button-discard-${row.id}`}>
                Discard
              </Button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo(f); e.target.value = ""; }}
              data-testid={`input-logo-file-${row.id}`}
            />
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              data-testid={`button-upload-logo-${row.id}`}
            >
              {uploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
              Upload logo
            </Button>
            <Input
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyLogoUrl(); } }}
              placeholder="Paste logo image URL"
              className="h-9 flex-1 min-w-0"
              disabled={applyingUrl}
              data-testid={`input-logo-url-${row.id}`}
            />
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              disabled={applyingUrl || !logoUrl.trim()}
              onClick={applyLogoUrl}
              data-testid={`button-apply-logo-url-${row.id}`}
            >
              {applyingUrl ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Use URL
            </Button>
            <div
              tabIndex={0}
              onPaste={handleLogoPaste}
              className="h-9 px-3 flex items-center rounded-md border border-input text-xs text-muted-foreground cursor-text hover-elevate focus:outline-none focus:ring-2 focus:ring-ring shrink-0 whitespace-nowrap"
              data-testid={`paste-logo-${row.id}`}
            >
              or paste image
            </div>
            <span className="text-[10px] text-muted-foreground shrink-0 whitespace-nowrap" data-testid={`text-updated-${row.id}`}>
              Last updated {row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "—"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// A blocked outlet shown in the Blocked tab, with a one-click unblock.
function BlockedOutletRow({ row }: { row: OutletRegistry }) {
  const { toast } = useToast();
  const unblock = useMutation({
    mutationFn: async () =>
      apiRequest("PATCH", `/api/team/outlet-registry/${row.id}/overrides`, { overrides: { blocked: false } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/team/outlet-registry"] });
      toast({ title: "Outlet unblocked", description: row.canonicalName });
    },
    onError: (e: Error) => toast({ title: "Unblock failed", description: e.message, variant: "destructive" }),
  });
  return (
    <div className="flex items-center gap-3 rounded-md border p-3" data-testid={`row-blocked-${row.id}`}>
      {resolveOutletLogo(row) ? (
        <img src={resolveOutletLogo(row)} alt={row.canonicalName} className="h-8 w-8 rounded-md object-contain shrink-0 bg-white" />
      ) : (
        <div className="h-8 w-8 rounded-md bg-muted text-muted-foreground flex items-center justify-center text-[10px] font-bold shrink-0">
          {(row.canonicalName || "?").slice(0, 2).toUpperCase()}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{outletDisplayName(row)}</div>
        <div className="text-xs text-muted-foreground truncate">
          {SOURCE_IDENTIFIER_LABELS[((row as Record<string, unknown>).sourceIdentifier as SourceIdentifier)] ?? "Other source"}{row.originCountry ? ` · ${row.originCountry}` : ""}
        </div>
      </div>
      <Button size="sm" variant="outline" disabled={unblock.isPending}
        onClick={() => unblock.mutate()} data-testid={`button-unblock-${row.id}`}>
        {unblock.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
        Unblock
      </Button>
    </div>
  );
}

export function OutletOversightDialog({
  open,
  onOpenChange,
  initialTab,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Optional deep link: which tab to show when the dialog opens (e.g. the
  // Team page's Priority/BOLO pointer opens straight to "watchtopics").
  initialTab?: string;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");

  // Controlled tab state so in-dialog cross-links (Scoring & Relevance →
  // Priority/BOLO) and the initialTab deep link both work.
  const [activeTab, setActiveTab] = useState(initialTab ?? "registry");
  useEffect(() => {
    if (open) setActiveTab(initialTab ?? "registry");
  }, [open, initialTab]);

  // Priority/BOLO watch topics — count badge for the tab (same endpoint the
  // management panel uses, so the cache is shared).
  const { data: watchTopicData } = useQuery<{
    joePriorities?: unknown[]; boloItems?: unknown[];
  }>({
    queryKey: ["/api/team/joe-priorities-bolo"],
    enabled: open,
  });
  const watchTopicCount =
    (watchTopicData?.joePriorities?.length || 0) + (watchTopicData?.boloItems?.length || 0);

  const { data: registry, isLoading: registryLoading } = useQuery<OutletRegistry[]>({
    queryKey: ["/api/team/outlet-registry"],
    enabled: open,
  });

  // Scoring & Relevance oversight (Task #622) — read-only, live-derived values.
  const { data: scoringRelevance, isLoading: scoringRelevanceLoading } = useQuery<ScoringRelevanceResponse>({
    queryKey: ["/api/team/scoring-relevance"],
    enabled: open,
  });

  const { data: filterMetrics } = useQuery<{
    financeWeatherRescued: number;
    financeWeatherDropped: number;
    quarantined: number;
    updatedAt: string | null;
  }>({
    queryKey: ["/api/team/filter-metrics"],
    enabled: open,
  });

  const { data: quarantineItems, isLoading: quarantineLoading } = useQuery<{
    id: string; title: string; url: string; source: string; reason: string; scrapedAt: string;
  }[]>({
    queryKey: ["/api/team/quarantine"],
    enabled: open,
  });

  // Read-only vocabulary-drift signals (Task #351).
  const { data: topics, isLoading: topicsLoading } = useQuery<ClassificationTopicsResponse>({
    queryKey: ["/api/team/classification-topics"],
    enabled: open,
  });

  // Coverage + Freshness (read-only oversight, Task #352). staleDays is the
  // configurable freshness threshold; hours is the curated lookback window.
  const [staleDays, setStaleDays] = useState("30");
  // Task #400: full-roster sections default to showing only the flagged rows;
  // these toggles reveal the (longer) healthy/resolved portion on demand.
  const [showHealthyFeeds, setShowHealthyFeeds] = useState(false);
  const [showHealthyRssFeeds, setShowHealthyRssFeeds] = useState(false);
  const [showActiveIntakeSources, setShowActiveIntakeSources] = useState(false);
  const [showBenignIntakeSources, setShowBenignIntakeSources] = useState(false);
  const [showHealthyOutlets, setShowHealthyOutlets] = useState(false);
  const [showNoRefOutlets, setShowNoRefOutlets] = useState(false);
  const [showResolvedSources, setShowResolvedSources] = useState(false);
  const [expandedPipeline, setExpandedPipeline] = useState<Record<string, boolean>>({});
  const [expandedMeltwater, setExpandedMeltwater] = useState<Set<string>>(new Set());
  const { data: coverageData, isLoading: coverageLoading } = useQuery<CoverageReport>({
    queryKey: ["/api/team/outlet-registry/coverage", staleDays],
    queryFn: async () => {
      const res = await fetch(`/api/team/outlet-registry/coverage?staleDays=${staleDays}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load coverage report");
      return res.json();
    },
    enabled: open,
  });

  // Live broadcast firing history (Task #509) — read-only audit of past banner
  // firings. Curated-gated endpoint; returns [] for non-curated viewers.
  const { data: firingsData, isLoading: firingsLoading } = useQuery<{
    canEdit: boolean;
    activeBanner: { eventKey: string | null; status: LiveAlertStatus | null; lastComputed: number | null };
    firings: ModeratedLiveFiring[];
  }>({
    queryKey: ["/api/curated/live-status/firings"],
    enabled: open,
  });
  const firings = firingsData?.firings ?? [];
  const canModerateLiveAlerts = firingsData?.canEdit === true;
  const [editingFiringId, setEditingFiringId] = useState<string | null>(null);
  const [liveAlertPendingAction, setLiveAlertPendingAction] = useState<"hide" | "restore" | "edit">("edit");
  const [liveAlertDraft, setLiveAlertDraft] = useState<LiveAlertStatus | null>(null);
  const [liveAlertReason, setLiveAlertReason] = useState("");
  const [liveAlertNote, setLiveAlertNote] = useState("");

  const refreshLiveAlerts = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/curated/live-status/firings"] });
    queryClient.invalidateQueries({ queryKey: ["/api/curated/live-status"] });
    queryClient.invalidateQueries({ queryKey: ["/api/curated/override-log"] });
  };

  const liveAlertMutation = useMutation({
    mutationFn: async (args: {
      firingId: string;
      action: "hide" | "restore" | "edit";
      fields?: LiveAlertStatus;
    }) => {
      const res = await apiRequest(
        "POST",
        `/api/curated/live-status/firings/${args.firingId}/${args.action}`,
        {
          reasonKey: liveAlertReason || null,
          reasonNote: liveAlertNote.trim() || null,
          ...(args.fields ? { fields: args.fields } : {}),
        },
      );
      return res.json() as Promise<LiveAlertMutationResult>;
    },
    onSuccess: (data, args) => {
      refreshLiveAlerts();
      setEditingFiringId(null);
      setLiveAlertDraft(null);
      setLiveAlertReason("");
      setLiveAlertNote("");
      toast({
        title: args.action === "hide" ? "Live alert hidden" : args.action === "restore" ? "Live alert restored" : "Live alert corrected",
        description: data.isCurrentBannerEvent
          ? data.activeBanner.status
            ? `Updated the current Curated banner: ${LIVE_ALERT_STATE_LABELS[data.activeBanner.status.state]}${data.activeBanner.status.state === "upcoming" ? ` · scheduled start ${formatLiveAlertTime(data.activeBanner.status.startsAt)}` : ""}.`
            : "Updated the current Curated banner: it is now hidden."
          : `Saved for “${data.selectedEvent.title}” only. That is a historical Live Log event; the current Curated banner was not changed.`,
      });
    },
    onError: (e: Error) => toast({ title: "Live alert update failed", description: e.message, variant: "destructive" }),
  });

  const beginLiveAlertEdit = (f: ModeratedLiveFiring) => {
    const effective = f.effectiveStatus ?? {
      state: f.state as LiveAlertState,
      leader: f.leader,
      title: f.title,
      watchUrl: f.watchUrl,
      ...(f.state === "upcoming" && f.startsAt ? { startsAt: new Date(f.startsAt as unknown as string).toISOString() } : {}),
      ...(f.state === "live" ? { since: new Date(f.firstObservedAt as unknown as string).toISOString() } : {}),
      ...(f.state === "recently_ended" && f.endedAt ? { endsAt: new Date(f.endedAt as unknown as string).toISOString() } : {}),
    };
    setEditingFiringId(f.id);
    setLiveAlertPendingAction("edit");
    setLiveAlertDraft(effective);
    setLiveAlertReason("");
    setLiveAlertNote("");
  };

  const beginLiveAlertAction = (f: ModeratedLiveFiring, action: "hide" | "restore") => {
    beginLiveAlertEdit(f);
    setLiveAlertPendingAction(action);
  };

  // ── Editor-override learning log (Task #540) ──────────────────────────────
  // Read-only oversight of every curated moderation action. Curated-gated
  // endpoint; never mutates feeds/scoring. As of Task #1180 the speculative
  // learned-rule queue + AI advisory brief are REPLACED by the editorial
  // evidence explorer below — nothing here approves or enforces anything.
  const { data: overrideLog, isLoading: overrideLogLoading } = useQuery<OverrideLogResponse>({
    queryKey: ["/api/curated/override-log"],
    enabled: open,
  });

  const pauseMutation = useMutation({
    mutationFn: async (paused: boolean) =>
      apiRequest("POST", "/api/curated/override-log/pause", { paused }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/curated/override-log"] });
    },
    onError: (e: Error) => toast({ title: "Could not change capture", description: e.message, variant: "destructive" }),
  });

  const resetMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/curated/override-log/reset", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/curated/override-log"] });
      queryClient.invalidateQueries({ queryKey: ["/api/curated/correction-telemetry"] });
      // Manual link/merge history now lives in the consolidated Adjustments tab
      // and is reset-aware (active = post-acknowledgedAt, archive = pre-reset).
      // Prefix invalidation covers BOTH query-key variants
      // (["/api/curated/manual-links", false] and [..., true]) so the current
      // view clears immediately on reset instead of waiting for a
      // reopen/toggle refetch.
      queryClient.invalidateQueries({ queryKey: ["/api/curated/manual-links"] });
      queryClient.invalidateQueries({ queryKey: ["/api/curated/editorial-evidence"] });
      toast({ title: "Adjustments reset", description: "The evidence view is cleared for a fresh tuning cycle. Past actions are kept for audit." });
    },
    onError: (e: Error) => toast({ title: "Could not reset adjustments", description: e.message, variant: "destructive" }),
  });

  // ── Editorial evidence explorer (Task #1180) ──────────────────────────────
  // Replaces the speculative learned-rule queue + AI advisory brief with a
  // read-only explorer over trustworthy training EVIDENCE. Filters/scope drive
  // BOTH the on-screen episode list and the deterministic Markdown packet the
  // development agent copies — never a standing rule, never an auto-enforced
  // model. Raw workload counts are kept clearly separate from evidence quality
  // and are NEVER labeled as learning confidence.
  const [evidenceFilters, setEvidenceFilters] = useState<EvidenceFilterState>(DEFAULT_EVIDENCE_FILTERS);
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    // Read the clock only in an effect so the initial render stays stable, and
    // so the "days back" window boundaries are computed against open time.
    if (open) setNowMs(Date.now());
  }, [open]);

  const evidenceParams = useMemo(() => evidenceQueryParams(evidenceFilters), [evidenceFilters]);
  const { data: evidenceData, isLoading: evidenceLoading } = useQuery<EditorialEvidenceResponse>({
    queryKey: ["/api/curated/editorial-evidence", evidenceParams],
    enabled: open,
  });
  const evidenceEpisodes = evidenceData?.episodes ?? [];
  const evidenceCounts = evidenceData?.counts ?? null;

  const [copyingPacket, setCopyingPacket] = useState(false);
  const [packetStatus, setPacketStatus] = useState<{ ok: boolean; message: string } | null>(null);

  // Frozen legacy learned-rule inventory (Task #1180) — deprecated speculative
  // rules kept for audit. NEVER approvable/enforceable; only dispositioned.
  const { data: legacyLearningData, isLoading: legacyLearningLoading } = useQuery<LegacyLearningResponse>({
    queryKey: ["/api/curated/legacy-learning"],
    enabled: open,
  });
  const legacyLearningItems = legacyLearningData?.items ?? [];
  const [dispositioningId, setDispositioningId] = useState<string | null>(null);

  const dispositionMutation = useMutation({
    mutationFn: async ({ id, disposition }: { id: string; disposition: LegacyDisposition }) =>
      apiRequest("POST", `/api/curated/legacy-learning/${id}/disposition`, { disposition }),
    onMutate: (v) => setDispositioningId(v.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/curated/legacy-learning"] });
      toast({ title: "Disposition recorded", description: "The frozen legacy item was updated. Nothing was approved or enforced." });
    },
    onError: (e: Error) => toast({ title: "Could not record disposition", description: e.message, variant: "destructive" }),
    onSettled: () => setDispositioningId(null),
  });

  // Copy the deterministic Markdown evidence packet (same filtered scope as the
  // on-screen list) to the clipboard for the development agent. Reports an
  // explicit visible success/error — never a silent no-op.
  const copyEvidencePacket = async () => {
    setCopyingPacket(true);
    setPacketStatus(null);
    let text = "";
    try {
      const res = await apiRequest(
        "GET",
        `/api/curated/editorial-evidence/packet${evidenceQueryString(evidenceFilters)}`,
      );
      text = await res.text();
    } catch (e) {
      setCopyingPacket(false);
      const msg = e instanceof Error ? e.message : "Could not build the evidence packet.";
      setPacketStatus({ ok: false, message: msg });
      toast({ title: "Couldn't build the evidence packet", description: msg, variant: "destructive" });
      return;
    }

    // The clipboard API can silently no-op or throw inside a restricted/iframe
    // preview context, so fall back to a hidden-textarea execCommand copy and
    // only report success when a copy method actually succeeded.
    const copyViaExecCommand = () => {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.top = "-9999px";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      document.body.removeChild(textarea);
      return ok;
    };

    const reportSuccess = () => {
      setPacketStatus({ ok: true, message: "Evidence packet copied to clipboard." });
      toast({ title: "Copied for development analysis", description: "The deterministic evidence packet is on your clipboard." });
    };
    const reportBlocked = () => {
      const msg = "Your browser blocked clipboard access. Try again, or select the text manually.";
      setPacketStatus({ ok: false, message: msg });
      toast({ title: "Couldn't copy the packet", description: msg, variant: "destructive" });
    };

    try {
      if (navigator.clipboard?.writeText && window.isSecureContext !== false) {
        await navigator.clipboard.writeText(text);
        reportSuccess();
        return;
      }
      throw new Error("Clipboard API unavailable");
    } catch {
      if (copyViaExecCommand()) {
        reportSuccess();
      } else {
        reportBlocked();
      }
    } finally {
      setCopyingPacket(false);
    }
  };

  // Curated View feedback inbox — editor-only; submissions from Curated viewers.
  interface CuratedFeedbackItem {
    id: string;
    feedbackType: 'request' | 'suggestion' | 'question';
    message: string;
    anonymous: boolean;
    wantsFollowUp: boolean;
    contactName: string | null;
    contactEmail: string | null;
    contactOrg: string | null;
    reviewed: boolean;
    reviewedBy: string | null;
    reviewedAt: string | null;
    submittedAt: string;
  }
  const { data: feedbackData, isLoading: feedbackLoading } = useQuery<{ items: CuratedFeedbackItem[] }>({
    queryKey: ["/api/curated/feedback"],
    enabled: open,
  });
  const feedbackItems = feedbackData?.items ?? [];
  const unreviewedFeedbackCount = feedbackItems.filter((f) => !f.reviewed).length;

  // Feedback inbox: "Active" (unreviewed) vs "Archived" (reviewed) views, plus
  // multi-select for bulk actions.
  const [feedbackView, setFeedbackView] = useState<"active" | "archived">("active");
  const [selectedFeedbackIds, setSelectedFeedbackIds] = useState<Set<string>>(new Set());
  const [showArchive, setShowArchive] = useState(false);
  const { data: archiveLog, isLoading: archiveLogLoading } = useQuery<OverrideLogResponse>({
    queryKey: ["/api/curated/override-log", { archive: true }],
    queryFn: async () => {
      const res = await fetch("/api/curated/override-log?archive=1", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load archive");
      return res.json();
    },
    enabled: open && showArchive,
    staleTime: 60_000,
  });
  const [feedbackDeleteTarget, setFeedbackDeleteTarget] = useState<{ mode: "single"; id: string } | { mode: "bulk"; ids: string[] } | null>(null);

  const displayedFeedback = feedbackItems.filter((f) => (feedbackView === "active" ? !f.reviewed : f.reviewed));
  const archivedFeedbackCount = feedbackItems.length - unreviewedFeedbackCount;
  const selectedInView = displayedFeedback.filter((f) => selectedFeedbackIds.has(f.id)).map((f) => f.id);
  const allInViewSelected = displayedFeedback.length > 0 && selectedInView.length === displayedFeedback.length;

  const clearFeedbackSelection = () => setSelectedFeedbackIds(new Set());
  const toggleFeedbackSelected = (id: string) => {
    setSelectedFeedbackIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAllInView = () => {
    setSelectedFeedbackIds((prev) => {
      if (allInViewSelected) return new Set();
      const next = new Set(prev);
      displayedFeedback.forEach((f) => next.add(f.id));
      return next;
    });
  };

  const refreshFeedback = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/curated/feedback"] });
    clearFeedbackSelection();
  };

  const reviewFeedbackMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("POST", `/api/curated/feedback/${id}/review`, {}),
    onSuccess: refreshFeedback,
    onError: (e: Error) => toast({ title: "Could not archive feedback", description: e.message, variant: "destructive" }),
  });

  const restoreFeedbackMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("POST", `/api/curated/feedback/${id}/unreview`, {}),
    onSuccess: refreshFeedback,
    onError: (e: Error) => toast({ title: "Could not restore feedback", description: e.message, variant: "destructive" }),
  });

  const deleteFeedbackMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/curated/feedback/${id}`),
    onSuccess: refreshFeedback,
    onError: (e: Error) => toast({ title: "Could not delete feedback", description: e.message, variant: "destructive" }),
  });

  const bulkReviewFeedbackMutation = useMutation({
    mutationFn: async (ids: string[]) => apiRequest("POST", `/api/curated/feedback/bulk-review`, { ids }),
    onSuccess: refreshFeedback,
    onError: (e: Error) => toast({ title: "Could not archive feedback", description: e.message, variant: "destructive" }),
  });

  const bulkDeleteFeedbackMutation = useMutation({
    mutationFn: async (ids: string[]) => apiRequest("POST", `/api/curated/feedback/bulk-delete`, { ids }),
    onSuccess: refreshFeedback,
    onError: (e: Error) => toast({ title: "Could not delete feedback", description: e.message, variant: "destructive" }),
  });

  const feedbackMutating =
    reviewFeedbackMutation.isPending ||
    restoreFeedbackMutation.isPending ||
    deleteFeedbackMutation.isPending ||
    bulkReviewFeedbackMutation.isPending ||
    bulkDeleteFeedbackMutation.isPending;

  // Editor-update audit trail (Task #430) — the curated manual link/merge log.
  // Parameterised by showArchive: active mode shows post-reset links only;
  // archive mode shows pre-reset links (created BEFORE acknowledgedAt).
  const { data: manualLinksData, isLoading: manualLinksLoading } = useQuery<{ links: ManualLinkRow[]; acknowledgedAt: string | null }>({
    queryKey: ["/api/curated/manual-links", showArchive],
    queryFn: async () => {
      const url = showArchive
        ? `/api/curated/manual-links?limit=200&archive=1`
        : `/api/curated/manual-links?limit=200`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load editor updates");
      return res.json();
    },
    enabled: open,
  });
  const manualLinks = manualLinksData?.links ?? [];
  const activeManualLinks = manualLinks.filter((l) => l.status === "active");

  const unlinkMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", "/api/curated/unlink", { id });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/curated/manual-links"] });
      queryClient.invalidateQueries({ queryKey: ["/api/curated/top-stories"] });
      queryClient.invalidateQueries({ queryKey: ["/api/curated/cluster-members"] });
      toast({ title: "Link removed", description: "Kept in the log as revoked." });
    },
    onError: () => toast({ title: "Failed to remove link", variant: "destructive" }),
  });

  const enrichMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/team/outlet-registry/run-enrichment");
      return res.json();
    },
    onSuccess: (summary: { processed: number; updated: number; confirmed: number; alreadyRunning?: boolean }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/team/outlet-registry"] });
      queryClient.invalidateQueries({ queryKey: ["/api/curated/outlets"] });
      toast({
        title: summary.alreadyRunning ? "Enrichment already running" : "Enrichment complete",
        description: summary.alreadyRunning
          ? "A pass is already in progress."
          : `Processed ${summary.processed}, updated ${summary.updated}, confirmed ${summary.confirmed}.`,
      });
    },
    onError: (e: Error) => toast({ title: "Enrichment failed", description: e.message, variant: "destructive" }),
  });

  const filtered = useMemo(() => {
    const rows = registry ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.canonicalName.toLowerCase().includes(q) ||
      ((r as { displayName?: string | null }).displayName ?? "").toLowerCase().includes(q) ||
      (r.aliases ?? []).some((a) => a.toLowerCase().includes(q)) ||
      (r.domains ?? []).some((d) => d.toLowerCase().includes(q)) ||
      (r.originCountry ?? "").toLowerCase().includes(q),
    );
  }, [registry, search]);

  const groupedRegistry = useMemo(() => {
    const social: OutletRegistry[] = [];
    const news: OutletRegistry[] = [];
    for (const row of filtered) {
      const accounts = findApprovedSocialAccountsForRegistryIdentity(
        row.canonicalName,
        row.aliases ?? [],
      );
      (accounts.length > 0 ? social : news).push(row);
    }
    return { news, social };
  }, [filtered]);

  const blockedOutlets = useMemo(
    () => (registry ?? []).filter((r) => (r as Record<string, unknown>).blocked === true),
    [registry],
  );

  const unconfirmedCount = useMemo(
    () => (registry ?? []).filter((r) => r.confirmationStatus !== "confirmed").length,
    [registry],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <DialogTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5" />
              Source Oversight
            </DialogTitle>
            <Badge
              variant="outline"
              className="gap-1 text-muted-foreground"
              data-testid="badge-curated-scope"
            >
              <Eye className="w-3 h-3" />
              Edits &amp; functions impact Curated View only
            </Badge>
          </div>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 min-h-0">
          <TabsList className="self-start h-auto flex-wrap justify-start gap-1">
            <TabsTrigger value="registry" data-testid="tab-registry">
              Registry
              {registry && <Badge variant="secondary" className="ml-2">{registry.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="blocked" data-testid="tab-blocked">
              Blocked
              {blockedOutlets.length > 0 && (
                <Badge variant="secondary" className="ml-2">{blockedOutlets.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="topics" data-testid="tab-topics">
              Topics
              {topics && (topics.proposals.length + topics.catchAllClusters.length) > 0 && (
                <Badge variant="secondary" className="ml-2">{topics.proposals.length + topics.catchAllClusters.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="coverage" data-testid="tab-coverage">
              Coverage
              {coverageData && (() => {
                // Count only genuinely-overdue outlets (exclude no-reference-data
                // ones which are permanently unenrichable by design).
                const overdueOutlets = coverageData.outlets.filter((o) => o.stale && !o.noReferenceData).length;
                const flagged =
                  coverageData.summary.feeds.silent +
                  coverageData.summary.sources.flagged +
                  overdueOutlets +
                  (coverageData.summary.pipeline.broken ?? 0) +
                  (coverageData.summary.pipeline.degraded ?? 0) +
                  (coverageData.summary.meltwater?.degraded ?? 0) +
                  (coverageData.summary.rssFeedHealth?.stale ?? 0);
                return flagged > 0 ? (
                  <Badge variant="destructive" className="ml-2" data-testid="badge-coverage-flagged">
                    {flagged}
                  </Badge>
                ) : null;
              })()}
            </TabsTrigger>
            <TabsTrigger value="livelog" data-testid="tab-livelog">
              Live Log
              {firings.length > 0 && (
                <Badge variant="secondary" className="ml-2">{firings.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="adjustments" data-testid="tab-adjustments">
              Adjustments
              {overrideLog && (overrideLog.report.totalEvents + activeManualLinks.length) > 0 && (
                <Badge variant="secondary" className="ml-2">{overrideLog.report.totalEvents + activeManualLinks.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="scoring" data-testid="tab-scoring">
              Scoring &amp; Relevance
            </TabsTrigger>
            <TabsTrigger value="watchtopics" data-testid="tab-watchtopics">
              Priority / BOLO
              {watchTopicCount > 0 && (
                <Badge variant="secondary" className="ml-2" data-testid="badge-watchtopics-count">{watchTopicCount}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="feedback" data-testid="tab-feedback">
              Feedback
              {unreviewedFeedbackCount > 0 && (
                <Badge variant="secondary" className="ml-2" data-testid="badge-feedback-unreviewed">{unreviewedFeedbackCount}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          {/* Registry tab */}
          <TabsContent value="registry" className="flex flex-col flex-1 min-h-0 mt-3 data-[state=inactive]:hidden">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <div className="relative flex-1 min-w-[180px]">
                <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-9 pl-8"
                  placeholder="Search outlets…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  data-testid="input-search-outlets"
                />
              </div>
              <Button
                size="default"
                variant="outline"
                disabled={enrichMutation.isPending}
                onClick={() => enrichMutation.mutate()}
                data-testid="button-run-enrichment"
              >
                {enrichMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RotateCw className="w-4 h-4 mr-2" />}
                Run enrichment
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mb-2">
              {unconfirmedCount} enrichment-pending (metadata not yet verified by an enrichment pass; this does not gate admission). Role is derived from Source Identifier, Other Source Type, factuality and the Blocked toggle. Manual overrides win over enrichment and persist; enrichment never changes role.
            </p>
            <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
              {registryLoading ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
                </div>
              ) : filtered.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground" data-testid="text-registry-empty">
                  No sources match.
                </div>
              ) : (
                <div className="space-y-5 pb-2">
                  {groupedRegistry.news.length > 0 && (
                    <section data-testid="section-registry-news">
                      <div className="mb-2 flex items-center gap-2">
                        <Rss className="h-4 w-4 text-muted-foreground" />
                        <h3 className="text-xs font-semibold">News outlets</h3>
                        <Badge variant="secondary">{groupedRegistry.news.length}</Badge>
                      </div>
                      <div className="space-y-2">
                        {groupedRegistry.news.map((row) => (
                          <OutletRow key={row.id} row={row} allRows={registry ?? []} />
                        ))}
                      </div>
                    </section>
                  )}
                  {groupedRegistry.social.length > 0 && (
                    <section data-testid="section-registry-social">
                      <div className="mb-1 flex items-center gap-2">
                        <RadioTower className="h-4 w-4 text-muted-foreground" />
                        <h3 className="text-xs font-semibold">Approved social accounts</h3>
                        <Badge variant="secondary">{groupedRegistry.social.length}</Badge>
                      </div>
                      <p className="mb-2 text-xs text-muted-foreground">
                        Approved for collection in the social-account catalog. Visibility and Curated behavior remain separate policies shown on each source.
                      </p>
                      <div className="space-y-2">
                        {groupedRegistry.social.map((row) => (
                          <OutletRow key={row.id} row={row} allRows={registry ?? []} />
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              )}
            </div>
          </TabsContent>

          {/* Blocked tab — blocked outlets + low-cred items held from the main feed */}
          <TabsContent value="blocked" className="flex flex-col flex-1 min-h-0 mt-3 data-[state=inactive]:hidden">
            <div className="grid grid-cols-3 gap-3 mb-3" data-testid="container-filter-metrics">
              <div className="rounded-md border p-3">
                <div className="text-2xl font-semibold" data-testid="text-metric-rescued">{filterMetrics?.financeWeatherRescued ?? 0}</div>
                <div className="text-xs text-muted-foreground">Finance/weather rescued</div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-2xl font-semibold" data-testid="text-metric-dropped">{filterMetrics?.financeWeatherDropped ?? 0}</div>
                <div className="text-xs text-muted-foreground">Finance/weather dropped</div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-2xl font-semibold" data-testid="text-metric-quarantined">{filterMetrics?.quarantined ?? 0}</div>
                <div className="text-xs text-muted-foreground">Held from main feed</div>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1 space-y-4">
              {/* Blocked outlets */}
              <div>
                <p className="text-xs font-medium mb-2">Blocked outlets</p>
                {blockedOutlets.length === 0 ? (
                  <div className="py-4 text-center text-sm text-muted-foreground" data-testid="text-blocked-outlets-empty">
                    No blocked outlets.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {blockedOutlets.map((row) => <BlockedOutletRow key={row.id} row={row} />)}
                  </div>
                )}
              </div>

              {/* Low-cred items held from the main feed (rerouted to Curated View) */}
              <div>
                <p className="text-xs font-medium mb-1">Held from main feed</p>
                <p className="text-xs text-muted-foreground mb-2">
                  Items from low-credibility sources are held out of the main feed. They are rerouted into the Curated View as attach-only — shown for contrast, never able to seed a story.
                </p>
                {quarantineLoading ? (
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
                  </div>
                ) : !quarantineItems || quarantineItems.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground" data-testid="text-quarantine-empty">
                    No held items.
                  </div>
                ) : (
                  <div className="space-y-2 pb-2">
                    {quarantineItems.map((item) => (
                      <div key={item.id} className="rounded-md border p-3" data-testid={`row-quarantine-${item.id}`}>
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-medium hover:underline"
                          data-testid={`link-quarantine-${item.id}`}
                        >
                          {item.title}
                          <ExternalLink className="w-3 h-3 inline ml-1 align-baseline" />
                        </a>
                        <div className="flex flex-wrap items-center gap-2 mt-2">
                          <Badge variant="outline" data-testid={`badge-quarantine-source-${item.id}`}>{item.source}</Badge>
                          <span className="text-xs text-muted-foreground" data-testid={`text-quarantine-reason-${item.id}`}>{item.reason}</span>
                          <span className="text-xs text-muted-foreground ml-auto">{new Date(item.scrapedAt).toLocaleString()}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </TabsContent>

          {/* Topics tab — read-only vocabulary-drift signals (Task #351). Helps a
              human decide when to grow the controlled vocabulary. Never mutates. */}
          <TabsContent value="topics" className="flex flex-col flex-1 min-h-0 mt-3 data-[state=inactive]:hidden">
            <p className="text-xs text-muted-foreground mb-3" data-testid="text-topics-intro">
              Read-only signals that the controlled vocabulary may need to grow. Off-list proposals are
              labels the curated generator could not place; catch-all clusters are stories that fell to
              "Other / Emerging". Nothing here changes the vocabulary — review and adjust the rules manually.
            </p>
            <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1 space-y-4">
              {topicsLoading ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
                </div>
              ) : (
                <>
                  {/* Section 1: most-frequent off-list topic proposals */}
                  <div>
                    <p className="text-xs font-medium mb-2 flex items-center gap-1.5">
                      <Tags className="w-3.5 h-3.5" /> Off-list topic proposals
                    </p>
                    {!topics || topics.proposals.length === 0 ? (
                      <div className="py-4 text-center text-sm text-muted-foreground" data-testid="text-proposals-empty">
                        No topic proposals logged.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {topics.proposals.map((p) => (
                          <div key={p.id} className="rounded-md border p-3" data-testid={`row-proposal-${p.id}`}>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium" data-testid={`text-proposal-label-${p.id}`}>{p.proposedLabel}</span>
                              <Badge variant="secondary" data-testid={`badge-proposal-count-${p.id}`}>{p.occurrences}×</Badge>
                              {p.status && (
                                <Badge variant="outline" data-testid={`badge-proposal-status-${p.id}`}>{p.status}</Badge>
                              )}
                              {p.kind && p.kind !== "primary_topic" && (
                                <Badge variant="outline" className="text-muted-foreground">{p.kind}</Badge>
                              )}
                            </div>
                            {p.sampleTitle && (
                              <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2" data-testid={`text-proposal-sample-${p.id}`}>
                                {p.sampleTitle}
                              </p>
                            )}
                            <div className="text-[11px] text-muted-foreground mt-1.5">
                              {p.firstProposedAt && <>First {new Date(p.firstProposedAt).toLocaleString()}</>}
                              {p.firstProposedAt && p.lastProposedAt && " · "}
                              {p.lastProposedAt && <>Last {new Date(p.lastProposedAt).toLocaleString()}</>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Section 2: largest "Other / Emerging" catch-all clusters */}
                  <div>
                    <p className="text-xs font-medium mb-1 flex items-center gap-1.5">
                      <Tags className="w-3.5 h-3.5" /> "Other / Emerging" clusters
                    </p>
                    <p className="text-xs text-muted-foreground mb-2">
                      Curated stories that landed in the catch-all over the last {topics?.windowHours ?? 168}h,
                      grouped by their specific category. Large recurring groups may warrant a new vocabulary entry.
                    </p>
                    {!topics || topics.catchAllClusters.length === 0 ? (
                      <div className="py-4 text-center text-sm text-muted-foreground" data-testid="text-catchall-empty">
                        No catch-all clusters in window.
                      </div>
                    ) : (
                      <div className="space-y-2 pb-2">
                        {topics.catchAllClusters.map((c, i) => (
                          <div key={`${c.category}-${i}`} className="rounded-md border p-3" data-testid={`row-catchall-${i}`}>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium" data-testid={`text-catchall-category-${i}`}>{c.category}</span>
                              <Badge variant="secondary" data-testid={`badge-catchall-count-${i}`}>{c.count}</Badge>
                            </div>
                            {c.sampleTitles.length > 0 && (
                              <ul className="mt-1.5 space-y-0.5">
                                {c.sampleTitles.map((t, j) => (
                                  <li key={j} className="text-xs text-muted-foreground line-clamp-1" data-testid={`text-catchall-sample-${i}-${j}`}>
                                    {t}
                                  </li>
                                ))}
                              </ul>
                            )}
                            <div className="text-[11px] text-muted-foreground mt-1.5">
                              {c.firstSeen && <>First {new Date(c.firstSeen).toLocaleString()}</>}
                              {c.firstSeen && c.lastSeen && " · "}
                              {c.lastSeen && <>Last {new Date(c.lastSeen).toLocaleString()}</>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground mt-2 pt-2 border-t" data-testid="text-topics-remap-help">
              To act on a signal, grow the controlled vocabulary in code, then back-fill the
              backlog by running{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                npx tsx scripts/curated-classification-remap.ts --apply --reapply-catchall
              </code>
              . The bare remap is a no-op once rows carry the "Other / Emerging" catch-all, so
              {" "}<code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">--reapply-catchall</code>{" "}
              is required (omit <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">--apply</code> for a dry run).
            </p>
          </TabsContent>

          {/* Coverage tab — read-only blind-spot + freshness report. Never mutates. */}
          <TabsContent value="coverage" className="flex flex-col flex-1 min-h-0 mt-3 data-[state=inactive]:hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <p className="text-xs text-muted-foreground">
                Read-only. Surfaces sources the registry can&apos;t resolve and confirmed outlets that are overdue for enrichment. No edits are made here.
              </p>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground">Stale after</span>
                <Select value={staleDays} onValueChange={setStaleDays}>
                  <SelectTrigger className="h-9 w-[120px]" data-testid="select-stale-days">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7">7 days</SelectItem>
                    <SelectItem value="14">14 days</SelectItem>
                    <SelectItem value="30">30 days</SelectItem>
                    <SelectItem value="60">60 days</SelectItem>
                    <SelectItem value="90">90 days</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1 space-y-4">
              {coverageLoading ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
                </div>
              ) : !coverageData ? (
                <div className="py-8 text-center text-sm text-muted-foreground" data-testid="text-coverage-error">
                  Couldn&apos;t load the coverage report.
                </div>
              ) : (
                <>
                  {/* TRUTH SOCIAL RELAY OUTAGE BANNER — prominent, derived live
                      from the heartbeat so it clears automatically on recovery.
                      (The SMS escalation was removed; banner-only now.) */}
                  {coverageData.relayOutage?.active && (() => {
                    const ro = coverageData.relayOutage;
                    const fmtDur = (ms: number) => {
                      const mins = Math.round(ms / 60000);
                      if (mins < 60) return `${mins}m`;
                      const h = Math.floor(mins / 60);
                      const m = mins % 60;
                      return m > 0 ? `${h}h ${m}m` : `${h}h`;
                    };
                    return (
                      <div className="rounded-md border border-destructive bg-destructive/10 p-3" data-testid="banner-relay-outage">
                        <div className="flex items-center gap-2 flex-wrap">
                          <AlertTriangle className="w-4 h-4 text-destructive shrink-0" />
                          <p className="text-sm font-semibold text-destructive" data-testid="text-relay-outage-title">
                            Truth Social relay DOWN — fallback scraper {ro.fallbackFresh ? "ACTIVE" : "OVERDUE"}
                          </p>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1" data-testid="text-relay-outage-detail">
                          No relay heartbeat for {ro.heartbeatAgeMs !== null ? fmtDur(ro.heartbeatAgeMs) : "an unknown time"}
                          {ro.heartbeatAt ? ` (last ${new Date(ro.heartbeatAt).toLocaleString()})` : ""}.{" "}
                          {ro.fallbackFresh
                            ? <>Backup scrapers are covering POTUS posts in PRIMARY mode{ro.fallbackLastRunAt ? ` — last run ${fmtDur(Date.now() - new Date(ro.fallbackLastRunAt).getTime())} ago` : ""}.</>
                            : <>Backup scraper has not run recently{ro.fallbackLastRunAt ? ` (last ${fmtDur(Date.now() - new Date(ro.fallbackLastRunAt).getTime())} ago)` : ""} — POTUS post coverage may be gapped.</>}{" "}
                          This banner clears automatically when the relay heartbeat resumes.
                        </p>
                      </div>
                    );
                  })()}

                  {/* PIPELINE HEALTH — read-only main-feed subsystem audit (Task #400) */}
                  <div>
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <Activity className="w-4 h-4 text-muted-foreground" />
                      <p className="text-xs font-medium">Pipeline health</p>
                      {coverageData.summary.pipeline.broken > 0 && (
                        <Badge variant="destructive" data-testid="badge-pipeline-broken">{coverageData.summary.pipeline.broken} broken</Badge>
                      )}
                      {coverageData.summary.pipeline.degraded > 0 && (
                        <Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-400" data-testid="badge-pipeline-degraded">{coverageData.summary.pipeline.degraded} degraded</Badge>
                      )}
                      <Badge variant="secondary" data-testid="badge-pipeline-healthy">{coverageData.summary.pipeline.healthy} healthy</Badge>
                      {coverageData.summary.pipeline.indeterminate > 0 && (
                        <Badge variant="outline" data-testid="badge-pipeline-indeterminate">{coverageData.summary.pipeline.indeterminate} unknown</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mb-2">
                      Read-only health of the main-feed ingestion subsystems (Classic / Visual / custom-MCOP). Each verdict is corroborated by <span className="font-medium">both</span> a runtime signal (scrape metadata / relay heartbeat) and the subsystem&apos;s own table freshness. Quiet windows aren&apos;t failures; missing signals read as <span className="font-medium">unknown</span>.
                    </p>
                    <div className="space-y-2">
                      {coverageData.pipeline.map((v) => {
                        const open = !!expandedPipeline[v.key];
                        const statusBadge =
                          v.status === "broken" ? <Badge variant="destructive" className="gap-1" data-testid={`badge-pipeline-status-${v.key}`}><XCircle className="w-3 h-3" /> Broken</Badge>
                          : v.status === "degraded" ? <Badge variant="outline" className="gap-1 border-amber-500/50 text-amber-600 dark:text-amber-400" data-testid={`badge-pipeline-status-${v.key}`}><AlertTriangle className="w-3 h-3" /> Degraded</Badge>
                          : v.status === "healthy" ? <Badge variant="secondary" className="gap-1 text-green-700 dark:text-green-400" data-testid={`badge-pipeline-status-${v.key}`}><CheckCircle2 className="w-3 h-3" /> Healthy</Badge>
                          : <Badge variant="outline" className="gap-1 text-muted-foreground" data-testid={`badge-pipeline-status-${v.key}`}><HelpCircle className="w-3 h-3" /> Unknown</Badge>;
                        const flagged = v.status === "broken" || v.status === "degraded";
                        return (
                          <div
                            key={v.key}
                            className={`rounded-md border p-3 ${flagged ? "border-destructive/40" : ""}`}
                            data-testid={`row-pipeline-${v.key}`}
                          >
                            <button
                              type="button"
                              onClick={() => setExpandedPipeline((p) => ({ ...p, [v.key]: !open }))}
                              className="w-full flex items-start justify-between gap-2 text-left hover-elevate rounded-md -m-1 p-1"
                              data-testid={`button-pipeline-toggle-${v.key}`}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-sm font-medium" data-testid={`text-pipeline-name-${v.key}`}>{v.name}</span>
                                  {statusBadge}
                                  {v.operatorAlert?.kind === "warning" && (
                                    <Badge
                                      variant="outline"
                                      className="gap-1 border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                                      data-testid={`badge-pipeline-alert-${v.key}`}
                                    >
                                      <AlertTriangle className="w-3 h-3" />
                                      Auth cookies expired
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground mt-1" data-testid={`text-pipeline-summary-${v.key}`}>{v.summary}</p>
                                {v.operatorAlert?.kind === "warning" && (
                                  <p
                                    className="text-xs font-medium text-amber-700 dark:text-amber-300 mt-1"
                                    data-testid={`text-pipeline-alert-${v.key}`}
                                  >
                                    {v.operatorAlert.message}
                                  </p>
                                )}
                              </div>
                              {open ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />}
                            </button>
                            {open && (
                              <div className="mt-2 pt-2 border-t space-y-1.5">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                                  <div className="text-xs">
                                    <span className="text-muted-foreground">Runtime signal: </span>
                                    <span className="font-medium" data-testid={`text-pipeline-runtime-${v.key}`}>{v.runtimeSignal}</span>
                                  </div>
                                  <div className="text-xs">
                                    <span className="text-muted-foreground">Table signal: </span>
                                    <span className="font-medium" data-testid={`text-pipeline-table-${v.key}`}>{v.tableSignal}</span>
                                  </div>
                                </div>
                                {v.evidence.length > 0 && (
                                  <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
                                    {v.evidence.map((e, i) => (
                                      <li key={i} data-testid={`text-pipeline-evidence-${v.key}-${i}`}>{e}</li>
                                    ))}
                                  </ul>
                                )}
                                {v.lastSuccessAt && (
                                  <div className="text-xs text-muted-foreground">
                                    Last success: {new Date(v.lastSuccessAt).toLocaleString()}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* MELTWATER API HEALTH — curated-lane only (Task #543 / #839) */}
                  {coverageData.meltwater && (() => {
                    const mwMulti = coverageData.meltwater;
                    const aggDegraded = coverageData.summary.meltwater.degraded > 0;

                    function mwBadgeFor(status: MeltwaterStatus, testId: string) {
                      return status === "healthy" ? (
                        <Badge variant="secondary" className="gap-1 text-green-700 dark:text-green-400" data-testid={testId}>
                          <CheckCircle2 className="w-3 h-3" /> Healthy
                        </Badge>
                      ) : status === "throttled" ? (
                        <Badge variant="outline" className="gap-1 border-amber-500/50 text-amber-600 dark:text-amber-400" data-testid={testId}>
                          <AlertTriangle className="w-3 h-3" /> Throttled
                        </Badge>
                      ) : status === "stale" ? (
                        <Badge variant="outline" className="gap-1 border-amber-500/50 text-amber-600 dark:text-amber-400" data-testid={testId}>
                          <AlertTriangle className="w-3 h-3" /> Stale
                        </Badge>
                      ) : status === "error" ? (
                        <Badge variant="destructive" className="gap-1" data-testid={testId}>
                          <XCircle className="w-3 h-3" /> Error
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1 text-muted-foreground" data-testid={testId}>
                          <HelpCircle className="w-3 h-3" /> Not run
                        </Badge>
                      );
                    }

                    return (
                      <div>
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <Activity className="w-4 h-4 text-muted-foreground" />
                          <p className="text-xs font-medium">Meltwater API</p>
                          {aggDegraded && (
                            <Badge variant="destructive" data-testid="badge-meltwater-degraded">degraded</Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mb-2">
                          Curated-only data pipe (2 saved searches, runs hourly + every 2h in production). Throttled = quota pause, not a fault. Shared daily quota across both searches.
                        </p>
                        {mwMulti.combinedQuota && mwMulti.combinedQuota.totalDayRemaining != null && (
                          <div
                            className={`mb-2 rounded-md border p-2 ${mwMulti.combinedQuota.belowFloor ? "border-amber-500/50 bg-amber-500/10" : ""}`}
                            data-testid="panel-meltwater-combined-quota"
                          >
                            <div className="flex items-center gap-2 flex-wrap">
                              {mwMulti.combinedQuota.belowFloor && (
                                <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
                              )}
                              <span className="text-xs text-muted-foreground">Shared quota remaining (most recent reading):</span>
                              <span
                                className={`text-xs font-medium ${mwMulti.combinedQuota.belowFloor ? "text-amber-700 dark:text-amber-400" : ""}`}
                                data-testid="text-meltwater-combined-quota"
                              >
                                {mwMulti.combinedQuota.totalDayRemaining}
                                {mwMulti.combinedQuota.dayLimit != null ? ` / ${mwMulti.combinedQuota.dayLimit} shared limit` : ""}
                              </span>
                              {mwMulti.combinedQuota.partial && (
                                <span className="text-xs text-muted-foreground" data-testid="text-meltwater-combined-partial">
                                  (partial — {mwMulti.combinedQuota.searchesWithTelemetry} of {mwMulti.combinedQuota.searchCount} searches reporting)
                                </span>
                              )}
                            </div>
                            {mwMulti.combinedQuota.belowFloor && (
                              <p className="mt-1 text-xs text-amber-700 dark:text-amber-400" data-testid="banner-meltwater-combined-quota-warning">
                                Shared quota remaining is below the warning floor ({mwMulti.combinedQuota.warningFloor} calls). Both searches draw from this shared pool — they may pause before the next daily reset.
                              </p>
                            )}
                          </div>
                        )}
                        <div className="space-y-2">
                          {mwMulti.searches.map((s) => {
                            const mw = s.health;
                            const flagged = mw.status === "error" || mw.status === "stale";
                            const isExpanded = expandedMeltwater.has(s.label);
                            return (
                              <div
                                key={s.label}
                                className={`rounded-md border p-3 ${flagged ? "border-destructive/40" : ""}`}
                                data-testid={`row-meltwater-health-${s.label}`}
                              >
                                <button
                                  type="button"
                                  onClick={() => setExpandedMeltwater((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(s.label)) next.delete(s.label);
                                    else next.add(s.label);
                                    return next;
                                  })}
                                  className="w-full flex items-start justify-between gap-2 text-left hover-elevate rounded-md -m-1 p-1"
                                  data-testid={`button-meltwater-toggle-${s.label}`}
                                >
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="text-sm font-medium" data-testid={`text-meltwater-name-${s.label}`}>{s.displayName}</span>
                                      {mwBadgeFor(mw.status, `badge-meltwater-status-${s.label}`)}
                                      <span className="text-xs text-muted-foreground">({s.cadenceLabel})</span>
                                    </div>
                                    <p className="text-xs text-muted-foreground mt-1" data-testid={`text-meltwater-summary-${s.label}`}>{mw.summary}</p>
                                  </div>
                                  {isExpanded ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />}
                                </button>
                                {mw.status === "healthy" && mw.quotaWarning && (
                                  <div
                                    className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-amber-700 dark:text-amber-400"
                                    data-testid={`banner-meltwater-quota-warning-${s.label}`}
                                  >
                                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                                    <p className="text-xs">
                                      Daily quota running low
                                      {mw.dayRemaining != null && (
                                        <>
                                          {" "}— {mw.dayRemaining}
                                          {mw.dayLimit != null ? `/${mw.dayLimit}` : ""} remaining
                                        </>
                                      )}
                                      . The bot may stop running before the next reset.
                                    </p>
                                  </div>
                                )}
                                {isExpanded && (
                                  <div className="mt-2 pt-2 border-t space-y-1.5">
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                                      {mw.lastRunAt && (
                                        <div className="text-xs">
                                          <span className="text-muted-foreground">Last run: </span>
                                          <span className="font-medium" data-testid={`text-meltwater-last-run-${s.label}`}>{new Date(mw.lastRunAt).toLocaleString()}</span>
                                        </div>
                                      )}
                                      {mw.outcome && (
                                        <div className="text-xs">
                                          <span className="text-muted-foreground">Outcome: </span>
                                          <span className="font-medium" data-testid={`text-meltwater-outcome-${s.label}`}>{mw.outcome}</span>
                                        </div>
                                      )}
                                      {mw.lastRunAt && (
                                        <div className="text-xs">
                                          <span className="text-muted-foreground">Items admitted / skipped: </span>
                                          <span className="font-medium" data-testid={`text-meltwater-counts-${s.label}`}>{mw.ingested} / {mw.skipped}</span>
                                        </div>
                                      )}
                                      {mw.dayRemaining != null && (
                                        <div className="text-xs">
                                          <span className="text-muted-foreground">Daily quota remaining: </span>
                                          <span className="font-medium" data-testid={`text-meltwater-quota-${s.label}`}>
                                            {mw.dayRemaining}{mw.dayLimit != null ? `/${mw.dayLimit}` : ""}
                                          </span>
                                        </div>
                                      )}
                                      {mw.dayResetAt && (
                                        <div className="text-xs">
                                          <span className="text-muted-foreground">Quota resets: </span>
                                          <span className="font-medium" data-testid={`text-meltwater-reset-${s.label}`}>{new Date(mw.dayResetAt).toLocaleString()}</span>
                                        </div>
                                      )}
                                      {mw.minuteRemaining != null && (
                                        <div className="text-xs">
                                          <span className="text-muted-foreground">Per-minute remaining: </span>
                                          <span className="font-medium" data-testid={`text-meltwater-minute-quota-${s.label}`}>{mw.minuteRemaining}</span>
                                        </div>
                                      )}
                                    </div>
                                    {mw.status === "not-run" && (
                                      <p className="text-xs text-muted-foreground" data-testid={`text-meltwater-not-run-note-${s.label}`}>
                                        The Meltwater bot only runs in the deployed production environment to preserve the shared daily API quota.
                                      </p>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                  {/* CONFIGURED FEEDS — full roster, silent ones flagged */}
                  <div>
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <RadioTower className="w-4 h-4 text-muted-foreground" />
                      <p className="text-xs font-medium">Configured feeds &amp; scrapers</p>
                      {coverageData.summary.feeds.silent > 0 && (
                        <Badge variant="destructive" data-testid="badge-feeds-silent">{coverageData.summary.feeds.silent} silent</Badge>
                      )}
                      <Badge variant="secondary" data-testid="badge-feeds-delivering">{coverageData.summary.feeds.total - coverageData.summary.feeds.silent} delivering</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mb-2">
                      Every configured curated feed/scraper ({coverageData.summary.feeds.total} total) and how many items it delivered in the last {coverageData.params.hours}h. A <span className="font-medium">silent</span> source delivered zero — it may be unreachable/blocked (e.g. a 403&apos;d RSS feed) or simply published nothing that passed the curation gate. Open the URL to check.
                    </p>
                    {(() => {
                      const silent = coverageData.feeds.filter((f) => !f.delivered);
                      const delivering = coverageData.feeds.filter((f) => f.delivered);
                      return (
                        <>
                          {silent.length === 0 ? (
                            <div className="py-3 text-center text-sm text-muted-foreground" data-testid="text-silent-empty">
                              Every configured curated source is delivering.
                            </div>
                          ) : (
                            <div className="space-y-2">
                              {silent.map((s) => (
                                <div key={s.name} className="rounded-md border border-destructive/40 p-3" data-testid={`row-silent-${s.name}`}>
                                  <div className="flex items-center justify-between gap-2 flex-wrap">
                                    <div className="min-w-0 flex items-center gap-2 flex-wrap">
                                      <span className="text-sm font-medium truncate" data-testid={`text-silent-name-${s.name}`}>{s.name}</span>
                                      <Badge variant="outline">{s.kind === "web" ? "Web scraper" : "RSS feed"}</Badge>
                                      <Badge variant="destructive" className="gap-1"><AlertTriangle className="w-3 h-3" /> Silent</Badge>
                                      {!s.registered && (
                                        <Badge variant="outline" className="gap-1">Not in registry</Badge>
                                      )}
                                    </div>
                                  </div>
                                  {s.urls.length > 0 && (
                                    <div className="mt-2 space-y-0.5">
                                      {s.urls.map((u, i) => (
                                        <a
                                          key={i}
                                          href={u}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="block text-xs text-muted-foreground hover:underline truncate"
                                          data-testid={`link-silent-url-${s.name}-${i}`}
                                        >
                                          {u}
                                          <ExternalLink className="w-3 h-3 inline ml-1 align-baseline" />
                                        </a>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                          {delivering.length > 0 && (
                            <div className="mt-2">
                              <button
                                type="button"
                                onClick={() => setShowHealthyFeeds((v) => !v)}
                                className="flex items-center gap-1 text-xs text-muted-foreground hover:underline"
                                data-testid="button-toggle-healthy-feeds"
                              >
                                {showHealthyFeeds ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                                {showHealthyFeeds ? "Hide" : "Show"} {delivering.length} delivering source{delivering.length === 1 ? "" : "s"}
                              </button>
                              {showHealthyFeeds && (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {delivering.map((s) => (
                                    <Badge key={s.name} variant="secondary" className="gap-1" data-testid={`badge-feed-delivering-${s.name}`}>
                                      <CheckCircle2 className="w-3 h-3 text-green-600 dark:text-green-400" />
                                      {s.name} · {s.itemCount}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>

                  {/* RSS FEED HEALTH — main RSS Monitor + Warfighter feeds that
                      hard-error or return zero items for several cycles (Task #542) */}
                  <div>
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <Rss className="w-4 h-4 text-muted-foreground" />
                      <p className="text-xs font-medium">RSS feed health</p>
                      {coverageData.summary.rssFeedHealth?.stale > 0 && (
                        <Badge variant="destructive" data-testid="badge-rssfeed-stale">{coverageData.summary.rssFeedHealth.stale} stale/broken</Badge>
                      )}
                      <Badge variant="secondary" data-testid="badge-rssfeed-healthy">{(coverageData.summary.rssFeedHealth?.total ?? 0) - (coverageData.summary.rssFeedHealth?.stale ?? 0)} healthy</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mb-2">
                      Per-feed outcome tracking for the RSS Monitor &amp; Warfighter feeds across scrape cycles. A feed is flagged <span className="font-medium">stale/broken</span> after it hard-errors or returns zero items for 3+ consecutive cycles — so a quietly-dead feed surfaces here instead of only spamming logs. Resets on restart; re-converges within a few cycles.
                    </p>
                    {(() => {
                      const rows = coverageData.rssFeedHealth?.feeds ?? [];
                      const stale = rows.filter((r) => r.stale);
                      const healthy = rows.filter((r) => !r.stale);
                      const outcomeLabel = (kind: RssFeedHealthRow["streakKind"], outcome: FeedOutcome) => {
                        if (kind === "error") return "Erroring";
                        if (kind === "empty") return "Zero items";
                        if (kind === "mixed") return "Erroring / zero items";
                        return outcome === "error" ? "Erroring" : outcome === "empty" ? "Zero items" : "Healthy";
                      };
                      if (rows.length === 0) {
                        return (
                          <div className="py-3 text-center text-sm text-muted-foreground" data-testid="text-rssfeed-empty">
                            No RSS scrape cycles observed yet this session.
                          </div>
                        );
                      }
                      return (
                        <>
                          {stale.length === 0 ? (
                            <div className="py-3 text-center text-sm text-muted-foreground" data-testid="text-rssfeed-none-stale">
                              Every observed RSS feed is delivering.
                            </div>
                          ) : (
                            <div className="space-y-2">
                              {stale.map((r) => (
                                <div key={r.url} className="rounded-md border border-destructive/40 p-3" data-testid={`row-rssfeed-${r.sourceName}`}>
                                  <div className="flex items-center justify-between gap-2 flex-wrap">
                                    <div className="min-w-0 flex items-center gap-2 flex-wrap">
                                      <span className="text-sm font-medium truncate" data-testid={`text-rssfeed-name-${r.sourceName}`}>{r.sourceName}</span>
                                      <Badge variant="outline">{r.scope === "warfighter" ? "Warfighter" : "RSS Monitor"}</Badge>
                                      <Badge variant="destructive" className="gap-1"><AlertTriangle className="w-3 h-3" /> {outcomeLabel(r.streakKind, r.lastOutcome)}</Badge>
                                      <Badge variant="secondary" data-testid={`badge-rssfeed-streak-${r.sourceName}`}>{r.consecutiveUnhealthy} cycles</Badge>
                                    </div>
                                  </div>
                                  {r.lastDetail && (
                                    <p className="text-xs text-muted-foreground mt-1 truncate" data-testid={`text-rssfeed-detail-${r.sourceName}`}>{r.lastDetail}</p>
                                  )}
                                  <a
                                    href={r.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="block text-xs text-muted-foreground hover:underline truncate mt-1"
                                    data-testid={`link-rssfeed-url-${r.sourceName}`}
                                  >
                                    {r.url}
                                    <ExternalLink className="w-3 h-3 inline ml-1 align-baseline" />
                                  </a>
                                </div>
                              ))}
                            </div>
                          )}
                          {healthy.length > 0 && (
                            <div className="mt-2">
                              <button
                                type="button"
                                onClick={() => setShowHealthyRssFeeds((v) => !v)}
                                className="flex items-center gap-1 text-xs text-muted-foreground hover:underline"
                                data-testid="button-toggle-healthy-rssfeeds"
                              >
                                {showHealthyRssFeeds ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                                {showHealthyRssFeeds ? "Hide" : "Show"} {healthy.length} healthy feed{healthy.length === 1 ? "" : "s"}
                              </button>
                              {showHealthyRssFeeds && (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {healthy.map((r) => (
                                    <Badge key={r.url} variant="secondary" className="gap-1" data-testid={`badge-rssfeed-healthy-${r.sourceName}`}>
                                      <CheckCircle2 className="w-3 h-3 text-green-600 dark:text-green-400" />
                                      {r.sourceName}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>

                  {/* CURATED INTAKE TELEMETRY (Task #950; honest three-state
                      funnel Task #1114) — per-source admission funnel persisted
                      after each ingest pass. Red is reserved for genuine failure
                      evidence; benign filtering stays neutral; deferred/mid-pass
                      states show as amber "pending" instead of a false alarm. */}
                  {(() => {
                    const allRows = coverageData.intakeTelemetry ?? [];
                    if (allRows.length === 0) return null;
                    const nowMs = Date.now();
                    // An ingest pass runs every ~5 min with admission totals landing
                    // ~4 min after the feed-stats write; anything older than this and
                    // still admission-pending means the pass never completed.
                    const PENDING_FRESH_MS = 10 * 60 * 1000;
                    // The drain-guard row is rewritten on every tripped pass; older
                    // than this window (e.g. after a redeploy reset) it is stale.
                    const BACKLOG_FRESH_MS = 30 * 60 * 1000;
                    // Synthetic RSS backlog drain-guard row written by the ingest
                    // pass: `fetched` carries the deferred volume, `kept` carries the
                    // consecutive-pass streak. Rendered as a banner, never as a row.
                    const backlogRow = allRows.find((r) => r.sourceName === "(rss-backlog)");
                    const backlogFresh = !!backlogRow && backlogRow.fetched > 0 &&
                      nowMs - new Date(backlogRow.updatedAt).getTime() < BACKLOG_FRESH_MS;
                    const rows = allRows.filter((r) => r.sourceName !== "(rss-backlog)");
                    const benignDrops = (r: IntakeTelemetryRow) =>
                      r.aged + r.dupInPass + r.dropDupUrl + r.dropDupBatch + r.dropFuzzyDup + r.dropBlocked;
                    const relevanceDrops = (r: IntakeTelemetryRow) =>
                      r.dropRelevanceRejected + r.dropRelevanceFinance;
                    const invalidOnly = (r: IntakeTelemetryRow) =>
                      r.ingested === 0
                      && r.dropInvalid > 0
                      && r.invalidOnlyStreak > 0;
                    const isMidPass = (r: IntakeTelemetryRow) =>
                      (r.admissionPending ?? false) && nowMs - new Date(r.updatedAt).getTime() < PENDING_FRESH_MS;
                    type FunnelState = "attention" | "pending" | "active" | "relevance" | "informational" | "benign";
                    const classify = (r: IntakeTelemetryRow): FunnelState => {
                      // Red strictly means an operational intake fault. Relevance
                      // and consumer-finance exclusions are editorial outcomes, not
                      // evidence that the source or admission path is broken.
                      if (r.ingested === 0 && !isMidPass(r)) {
                        if ((r.fetchFailures ?? 0) > 0 && r.fetched === 0) return "attention";
                        if (r.dropGateUnscored > 0 && (r.deferred ?? 0) === 0) return "attention";
                        if (invalidOnly(r) && r.invalidOnlyStreak >= 2) return "attention";
                      }
                      if (isMidPass(r) || (r.deferred ?? 0) > 0 || (r.admissionPending ?? false)) return "pending";
                      if (r.ingested > 0) return "active";
                      if (relevanceDrops(r) > 0 && relevanceDrops(r) + benignDrops(r) === relevanceDrops(r)) return "relevance";
                      if (invalidOnly(r)) return "informational";
                      return "benign";
                    };
                    const reasonChips = (r: IntakeTelemetryRow): Array<[string, number]> =>
                      (
                        [
                          ["aged-out", r.aged],
                          ["dup-url", r.dropDupUrl],
                          ["dup-in-pass", r.dupInPass + r.dropDupBatch],
                          ["relevance-rejected", r.dropRelevanceRejected],
                          ["finance-rejected", r.dropRelevanceFinance],
                          ["gate-unscored", r.dropGateUnscored],
                          ["fuzzy-dup", r.dropFuzzyDup],
                          ["blocked", r.dropBlocked],
                          ["invalid", r.dropInvalid],
                          ["fetch-failed", r.fetchFailures ?? 0],
                        ] as Array<[string, number]>
                      ).filter(([, n]) => n > 0);
                    const attention = rows.filter((r) => classify(r) === "attention")
                      .sort((a, b) => ((b.fetchFailures ?? 0) + b.dropGateUnscored + b.invalidOnlyStreak) - ((a.fetchFailures ?? 0) + a.dropGateUnscored + a.invalidOnlyStreak));
                    const pending = rows.filter((r) => classify(r) === "pending")
                      .sort((a, b) => (b.deferred ?? 0) - (a.deferred ?? 0));
                    const active = rows.filter((r) => classify(r) === "active")
                      .sort((a, b) => b.ingested - a.ingested);
                    const benign = rows.filter((r) => classify(r) === "benign")
                      .sort((a, b) => benignDrops(b) - benignDrops(a));
                    const relevance = rows.filter((r) => classify(r) === "relevance")
                      .sort((a, b) => relevanceDrops(b) - relevanceDrops(a));
                    const informational = rows.filter((r) => classify(r) === "informational")
                      .sort((a, b) => b.dropInvalid - a.dropInvalid);
                    return (
                      <div>
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <Activity className="w-4 h-4 text-muted-foreground" />
                          <p className="text-xs font-medium">Intake admission funnel</p>
                          {attention.length > 0 && (
                            <Badge variant="destructive" data-testid="badge-intake-attention">{attention.length} needs attention</Badge>
                          )}
                          {pending.length > 0 && (
                            <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400" data-testid="badge-intake-pending">{pending.length} pending</Badge>
                          )}
                          <Badge variant="secondary" data-testid="badge-intake-active">{rows.length} tracked</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mb-2">
                          Per-source snapshot from the last curated ingest pass. <span className="font-medium">Needs attention</span> = a failed fetch, unavailable gate decision, or repeated invalid-only content. <span className="font-medium">Filtered by relevance</span> is an editorial outcome, not an operational alert. <span className="font-medium">Pending</span> = items deferred to the next pass or a pass still in flight. Aged-out and duplicate drops are normal filtering and stay quiet.
                        </p>
                        {backlogFresh && backlogRow && (
                          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5 mb-2" data-testid="banner-intake-rss-backlog">
                            <div className="flex items-center gap-2 flex-wrap">
                              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                              <span className="text-xs font-medium">RSS backlog not converging</span>
                              <Badge variant="outline" className="text-xs border-amber-500/50 text-amber-700 dark:text-amber-400">~{backlogRow.fetched} deferred / pass</Badge>
                              <Badge variant="outline" className="text-xs border-amber-500/50 text-amber-700 dark:text-amber-400">{backlogRow.kept} consecutive pass{backlogRow.kept === 1 ? "" : "es"}</Badge>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              The ingest pass keeps hitting its time budget before the whole RSS batch is admitted. Newest items are processed first; the remainder retries next pass. Updated {new Date(backlogRow.updatedAt).toLocaleString()}.
                            </p>
                          </div>
                        )}
                        {attention.length > 0 && (
                          <div className="space-y-1.5 mb-2">
                            {attention.map((r) => {
                              const fetchDead = (r.fetchFailures ?? 0) > 0 && r.fetched === 0;
                              return (
                                <div
                                  key={`${r.sourceName}:${r.lastLabel}`}
                                  className="rounded-md border border-destructive/40 p-2.5"
                                  data-testid={`row-intake-attention-${r.sourceName}`}
                                >
                                  <div className="flex items-center gap-2 flex-wrap mb-1">
                                    <span className="text-sm font-medium" data-testid={`text-intake-name-${r.sourceName}`}>{r.sourceName}</span>
                                    <Badge variant="outline" className="text-xs">{r.lastLabel}</Badge>
                                    <Badge variant="destructive" className="text-xs gap-1">
                                      <XCircle className="w-3 h-3" /> {fetchDead ? "feed fetch failed" : r.dropGateUnscored > 0 ? "gate decision unavailable" : `invalid content repeated ${r.invalidOnlyStreak} passes`}
                                    </Badge>
                                  </div>
                                  <div className="flex flex-wrap gap-1">
                                    {r.fetched > 0 && (
                                      <Badge variant="secondary" className="text-xs" data-testid={`badge-intake-fetched-${r.sourceName}`}>fetched {r.fetched}</Badge>
                                    )}
                                    {reasonChips(r).map(([label, n]) => (
                                      <Badge key={label} variant="outline" className="text-xs text-amber-700 dark:text-amber-400 border-amber-500/50" data-testid={`badge-intake-drop-${r.sourceName}-${label}`}>
                                        {label} {n}
                                      </Badge>
                                    ))}
                                  </div>
                                  {(r.fetchFailures ?? 0) > 0 && r.lastFetchError && (
                                    <div className="mt-1 text-xs text-destructive/90 font-mono break-all" data-testid={`text-intake-fetch-error-${r.sourceName}`}>
                                      {r.lastFetchError}
                                    </div>
                                  )}
                                  <div className="mt-1 text-xs text-muted-foreground">
                                    Last run: {new Date(r.lastRunAt).toLocaleString()}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {pending.length > 0 && (
                          <div className="space-y-1.5 mb-2">
                            {pending.map((r) => {
                              const label = (r.deferred ?? 0) > 0
                                ? `${r.deferred} deferred to next pass`
                                : isMidPass(r)
                                  ? "pass in flight — results pending"
                                  : "admission incomplete — retrying next pass";
                              return (
                                <div
                                  key={`${r.sourceName}:${r.lastLabel}`}
                                  className="rounded-md border border-amber-500/40 p-2.5"
                                  data-testid={`row-intake-pending-${r.sourceName}`}
                                >
                                  <div className="flex items-center gap-2 flex-wrap mb-1">
                                    <span className="text-sm font-medium" data-testid={`text-intake-name-${r.sourceName}`}>{r.sourceName}</span>
                                    <Badge variant="outline" className="text-xs">{r.lastLabel}</Badge>
                                    <Badge variant="outline" className="text-xs gap-1 border-amber-500/50 text-amber-700 dark:text-amber-400" data-testid={`badge-intake-pending-state-${r.sourceName}`}>
                                      <Clock className="w-3 h-3" /> {label}
                                    </Badge>
                                  </div>
                                  <div className="flex flex-wrap gap-1">
                                    {r.fetched > 0 && (
                                      <Badge variant="secondary" className="text-xs" data-testid={`badge-intake-fetched-${r.sourceName}`}>fetched {r.fetched}</Badge>
                                    )}
                                    {r.kept > 0 && (
                                      <Badge variant="secondary" className="text-xs">kept {r.kept}</Badge>
                                    )}
                                    {r.ingested > 0 && (
                                      <Badge variant="secondary" className="text-xs">admitted {r.ingested}</Badge>
                                    )}
                                    {reasonChips(r).map(([label2, n]) => (
                                      <Badge key={label2} variant="outline" className="text-xs text-muted-foreground" data-testid={`badge-intake-drop-${r.sourceName}-${label2}`}>
                                        {label2} {n}
                                      </Badge>
                                    ))}
                                  </div>
                                  <div className="mt-1 text-xs text-muted-foreground">
                                    Last run: {new Date(r.lastRunAt).toLocaleString()}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {relevance.length > 0 && (
                          <div className="mb-2">
                            <button
                              type="button"
                              onClick={() => setShowBenignIntakeSources((v) => !v)}
                              className="flex items-center gap-1 text-xs text-muted-foreground hover:underline"
                              data-testid="button-toggle-relevance-intake"
                            >
                              {showBenignIntakeSources ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                              {showBenignIntakeSources ? "Hide" : "Show"} {relevance.length} source{relevance.length === 1 ? "" : "s"} filtered by relevance
                            </button>
                            {showBenignIntakeSources && (
                              <div className="mt-1.5 space-y-1">
                                {relevance.map((r) => (
                                  <div key={`${r.sourceName}:${r.lastLabel}`} className="flex items-center gap-1.5 flex-wrap text-xs" data-testid={`row-intake-relevance-${r.sourceName}`}>
                                    <span className="font-medium">{r.sourceName}</span>
                                    <Badge variant="outline" className="text-xs">{r.lastLabel}</Badge>
                                    <span className="text-muted-foreground">0 admitted — editorial filtering:</span>
                                    {reasonChips(r).map(([label, n]) => (
                                      <Badge key={label} variant="outline" className="text-xs text-muted-foreground" data-testid={`badge-intake-drop-${r.sourceName}-${label}`}>{label} {n}</Badge>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {informational.length > 0 && (
                          <div className="mb-2 text-xs text-muted-foreground" data-testid="text-intake-invalid-informational">
                            {informational.map((r) => (
                              <div key={`${r.sourceName}:${r.lastLabel}`} className="flex items-center gap-1.5 flex-wrap mt-1">
                                <span className="font-medium">{r.sourceName}</span>
                                <Badge variant="outline" className="text-xs">{r.lastLabel}</Badge>
                                <span>invalid content {r.dropInvalid} — informational; this becomes an alert only if it repeats next pass</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {benign.length > 0 && (
                          <div className="mb-1.5">
                            <button
                              type="button"
                              onClick={() => setShowBenignIntakeSources((v) => !v)}
                              className="flex items-center gap-1 text-xs text-muted-foreground hover:underline"
                              data-testid="button-toggle-benign-intake"
                            >
                              {showBenignIntakeSources ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                              {showBenignIntakeSources ? "Hide" : "Show"} {benign.length} source{benign.length === 1 ? "" : "s"} filtered as expected
                            </button>
                            {showBenignIntakeSources && (
                              <div className="mt-1.5 space-y-1">
                                {benign.map((r) => {
                                  const chips = reasonChips(r);
                                  return (
                                    <div
                                      key={`${r.sourceName}:${r.lastLabel}`}
                                      className="flex items-center gap-1.5 flex-wrap text-xs"
                                      data-testid={`row-intake-benign-${r.sourceName}`}
                                    >
                                      <span className="font-medium">{r.sourceName}</span>
                                      <Badge variant="outline" className="text-xs">{r.lastLabel}</Badge>
                                      {chips.length > 0 ? (
                                        <>
                                          <span className="text-muted-foreground">0 admitted — normal filtering:</span>
                                          {chips.map(([label, n]) => (
                                            <Badge key={label} variant="outline" className="text-xs text-muted-foreground" data-testid={`badge-intake-drop-${r.sourceName}-${label}`}>
                                              {label} {n}
                                            </Badge>
                                          ))}
                                        </>
                                      ) : (
                                        <span className="text-muted-foreground">no candidates this pass</span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                        {active.length > 0 && (
                          <div>
                            <button
                              type="button"
                              onClick={() => setShowActiveIntakeSources((v) => !v)}
                              className="flex items-center gap-1 text-xs text-muted-foreground hover:underline"
                              data-testid="button-toggle-active-intake"
                            >
                              {showActiveIntakeSources ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                              {showActiveIntakeSources ? "Hide" : "Show"} {active.length} admitting source{active.length === 1 ? "" : "s"}
                            </button>
                            {showActiveIntakeSources && (
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {active.map((r) => (
                                  <Badge
                                    key={`${r.sourceName}:${r.lastLabel}`}
                                    variant="secondary"
                                    className="gap-1 text-xs"
                                    data-testid={`badge-intake-active-${r.sourceName}`}
                                  >
                                    <CheckCircle2 className="w-3 h-3 text-green-600 dark:text-green-400" />
                                    {r.sourceName} ({r.ingested}{(r.fetchFailures ?? 0) > 0 ? `, ${r.fetchFailures} fetch-fail` : ""})
                                  </Badge>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {attention.length === 0 && pending.length === 0 && (
                          <div className="py-2 text-center text-xs text-muted-foreground" data-testid="text-intake-healthy">
                            No intake sources need attention — editorial relevance and normal filtering do not count as failures.
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* SOURCES — full resolution roster, unresolved/fallback flagged */}
                  <div>
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <Radar className="w-4 h-4 text-muted-foreground" />
                      <p className="text-xs font-medium">Source resolution</p>
                      {coverageData.summary.sources.flagged > 0 && (
                        <Badge variant="destructive" data-testid="badge-sources-flagged">{coverageData.summary.sources.flagged} flagged</Badge>
                      )}
                      <Badge variant="secondary" data-testid="badge-sources-resolved">{coverageData.summary.sources.total - coverageData.summary.sources.flagged} resolved</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mb-2">
                      How recent curated sources (last {coverageData.params.hours}h) resolve against the registry. <span className="font-medium">Flagged</span> rows don&apos;t resolve to a registry row, or only resolve via a generic parent domain — add a domain/alias to the matching outlet on the Registry tab to fix.
                    </p>
                    {(() => {
                      const flagged = coverageData.sources.filter((g) => g.status !== "resolved");
                      const resolved = coverageData.sources.filter((g) => g.status === "resolved");
                      return (
                        <>
                          {flagged.length === 0 ? (
                            <div className="py-3 text-center text-sm text-muted-foreground" data-testid="text-coverage-empty">
                              Every recent source resolves cleanly.
                            </div>
                          ) : (
                            <div className="space-y-2">
                              {flagged.map((g) => (
                                <div key={g.key} className="rounded-md border border-destructive/40 p-3" data-testid={`row-coverage-${g.key}`}>
                                  <div className="flex items-center justify-between gap-2 flex-wrap">
                                    <div className="min-w-0 flex items-center gap-2 flex-wrap">
                                      <span className="text-sm font-medium truncate" data-testid={`text-coverage-key-${g.key}`}>
                                        {g.domain ?? g.sampleSources[0] ?? g.key}
                                      </span>
                                      {g.status === "unresolved" ? (
                                        <Badge variant="destructive" className="gap-1">
                                          <AlertTriangle className="w-3 h-3" /> Unresolved
                                        </Badge>
                                      ) : (
                                        <Badge variant="outline" className="gap-1 border-amber-500/50 text-amber-600 dark:text-amber-400">
                                          Parent-domain → {g.matchedOutlet ?? g.matchedDomain}
                                        </Badge>
                                      )}
                                    </div>
                                    <Badge variant="secondary" data-testid={`badge-coverage-volume-${g.key}`}>{g.count}</Badge>
                                  </div>
                                  {g.sampleSources.length > 0 && (
                                    <div className="text-xs text-muted-foreground mt-1 truncate">
                                      Source: {g.sampleSources.join(" · ")}
                                    </div>
                                  )}
                                  {g.sampleUrls.length > 0 && (
                                    <div className="mt-2 space-y-0.5">
                                      {g.sampleUrls.map((u, i) => (
                                        <a
                                          key={i}
                                          href={u}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="block text-xs text-muted-foreground hover:underline truncate"
                                          data-testid={`link-coverage-sample-${g.key}-${i}`}
                                        >
                                          {u}
                                          <ExternalLink className="w-3 h-3 inline ml-1 align-baseline" />
                                        </a>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                          {resolved.length > 0 && (
                            <div className="mt-2">
                              <button
                                type="button"
                                onClick={() => setShowResolvedSources((v) => !v)}
                                className="flex items-center gap-1 text-xs text-muted-foreground hover:underline"
                                data-testid="button-toggle-resolved-sources"
                              >
                                {showResolvedSources ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                                {showResolvedSources ? "Hide" : "Show"} {resolved.length} resolved source{resolved.length === 1 ? "" : "s"}
                              </button>
                              {showResolvedSources && (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {resolved.map((g) => (
                                    <Badge key={g.key} variant="secondary" className="gap-1" data-testid={`badge-source-resolved-${g.key}`}>
                                      <CheckCircle2 className="w-3 h-3 text-green-600 dark:text-green-400" />
                                      {g.matchedOutlet ?? g.domain ?? g.sampleSources[0] ?? g.key} · {g.count}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>

                  {/* OUTLETS — full roster, stale ones flagged */}
                  <div>
                    {(() => {
                      const overdue = coverageData.outlets.filter((o) => o.stale && !o.noReferenceData);
                      const noRef = coverageData.outlets.filter((o) => o.stale && o.noReferenceData);
                      const fresh = coverageData.outlets.filter((o) => !o.stale);
                      return (
                        <>
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <Clock className="w-4 h-4 text-muted-foreground" />
                            <p className="text-xs font-medium">Outlet freshness</p>
                            {overdue.length > 0 && (
                              <Badge variant="destructive" data-testid="badge-outlets-stale">{overdue.length} overdue</Badge>
                            )}
                            {noRef.length > 0 && (
                              <Badge variant="outline" className="text-muted-foreground" data-testid="badge-outlets-no-ref">{noRef.length} no reference data</Badge>
                            )}
                            <Badge variant="secondary" data-testid="badge-outlets-fresh">{fresh.length} fresh</Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mb-2">
                            Every confirmed outlet ({coverageData.summary.outlets.total} total) and its enrichment freshness.{" "}
                            <span className="font-medium">Overdue</span> outlets haven&apos;t been enriched in over {staleDays} days and have reference data available — the next enrichment pass will repair them.{" "}
                            <span className="font-medium">No reference data</span> outlets (social accounts, aggregators, officials with no factuality rating) are permanently unenrichable by the current dataset; add an entry to the reference dataset to cover them.
                            {" "}Manually overridden fields are excluded.
                          </p>

                          {overdue.length === 0 && noRef.length === 0 ? (
                            <div className="py-3 text-center text-sm text-muted-foreground" data-testid="text-freshness-empty">
                              No confirmed outlets are overdue.
                            </div>
                          ) : (
                            <>
                              {overdue.length > 0 && (
                                <div className="space-y-2 mb-3">
                                  <p className="text-xs font-medium text-destructive">Overdue ({overdue.length})</p>
                                  {overdue.map((o) => (
                                    <div key={o.id} className="flex items-center gap-3 rounded-md border border-destructive/40 p-3" data-testid={`row-freshness-${o.id}`}>
                                      {resolveOutletLogo(o as unknown as OutletRegistry) ? (
                                        <img src={resolveOutletLogo(o as unknown as OutletRegistry)} alt={o.canonicalName} className="h-8 w-8 rounded-md object-contain shrink-0 bg-white" />
                                      ) : (
                                        <div className="h-8 w-8 rounded-md bg-muted text-muted-foreground flex items-center justify-center text-[10px] font-bold shrink-0">
                                          {(o.canonicalName || "?").slice(0, 2).toUpperCase()}
                                        </div>
                                      )}
                                      <div className="min-w-0 flex-1">
                                        <div className="text-sm font-medium truncate" data-testid={`text-freshness-name-${o.id}`}>{o.canonicalName}</div>
                                        <div className="text-xs text-muted-foreground truncate">
                                          {SOURCE_IDENTIFIER_LABELS[(o.sourceIdentifier as SourceIdentifier)] ?? "Other source"}
                                          {o.factuality ? ` · factuality ${o.factuality}` : ""}
                                        </div>
                                      </div>
                                      <div className="text-xs text-muted-foreground text-right shrink-0" data-testid={`text-freshness-age-${o.id}`}>
                                        {o.freshestAt ? `Enriched ${new Date(o.freshestAt).toLocaleDateString()}` : "Never enriched"}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}

                              {noRef.length > 0 && (
                                <div className="mt-1">
                                  <button
                                    type="button"
                                    onClick={() => setShowNoRefOutlets((v) => !v)}
                                    className="flex items-center gap-1 text-xs text-muted-foreground hover:underline mb-1"
                                    data-testid="button-toggle-noref-outlets"
                                  >
                                    {showNoRefOutlets ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                                    {showNoRefOutlets ? "Hide" : "Show"} {noRef.length} outlet{noRef.length === 1 ? "" : "s"} with no reference data
                                  </button>
                                  {showNoRefOutlets && (
                                    <div className="flex flex-wrap gap-1.5 mt-1">
                                      {noRef.map((o) => (
                                        <Badge key={o.id} variant="outline" className="gap-1 text-muted-foreground" data-testid={`badge-outlet-noref-${o.id}`}>
                                          <HelpCircle className="w-3 h-3" />
                                          {o.canonicalName}
                                        </Badge>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </>
                          )}

                          {fresh.length > 0 && (
                            <div className="mt-2 pb-2">
                              <button
                                type="button"
                                onClick={() => setShowHealthyOutlets((v) => !v)}
                                className="flex items-center gap-1 text-xs text-muted-foreground hover:underline"
                                data-testid="button-toggle-fresh-outlets"
                              >
                                {showHealthyOutlets ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                                {showHealthyOutlets ? "Hide" : "Show"} {fresh.length} fresh outlet{fresh.length === 1 ? "" : "s"}
                              </button>
                              {showHealthyOutlets && (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {fresh.map((o) => (
                                    <Badge key={o.id} variant="secondary" className="gap-1" data-testid={`badge-outlet-fresh-${o.id}`}>
                                      <CheckCircle2 className="w-3 h-3 text-green-600 dark:text-green-400" />
                                      {o.canonicalName}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </>
              )}
            </div>
          </TabsContent>

          {/* Live Log tab — firing audit plus editor-only Curated moderation. */}
          <TabsContent value="livelog" className="flex flex-col flex-1 min-h-0 mt-3 data-[state=inactive]:hidden">
            <div className="text-xs text-muted-foreground mb-3 flex items-center gap-2">
              <RadioTower className="w-4 h-4" />
              Last 72 hours of live-broadcast banner firings (most recent first).
            </div>
            <div className="flex-1 overflow-y-auto">
              {firingsLoading ? (
                <div className="flex items-center justify-center py-10 text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin" />
                </div>
              ) : firings.length === 0 ? (
                <div className="text-sm text-muted-foreground py-10 text-center" data-testid="text-livelog-empty">
                  No broadcast firings recorded in the last 72 hours.
                </div>
              ) : (
                <div className="space-y-2">
                  {firings.map((f) => {
                    const firedAt = new Date(f.createdAt as unknown as string);
                    const ended = f.endedAt ? new Date(f.endedAt as unknown as string) : null;
                    const durationMs = ended ? ended.getTime() - firedAt.getTime() : null;
                    const durationLabel = (() => {
                      if (durationMs == null || durationMs < 0) return null;
                      const mins = Math.round(durationMs / 60000);
                      if (mins < 60) return `${mins}m`;
                      const h = Math.floor(mins / 60);
                      const m = mins % 60;
                      return m === 0 ? `${h}h` : `${h}h ${m}m`;
                    })();
                    const effective = f.effectiveStatus;
                    const displayState = effective?.state ?? (f.state as LiveAlertState);
                    const stateTime = displayState === "upcoming"
                      ? effective?.startsAt ?? f.startsAt
                      : displayState === "live"
                        ? effective?.since ?? f.firstObservedAt
                        : effective?.endsAt ?? f.endedAt;
                    const stateTimeLabel = displayState === "upcoming"
                      ? "Scheduled start"
                      : displayState === "live"
                        ? "Live since"
                        : "Ended";
                    const stateVariant =
                      displayState === "live" ? "destructive" : displayState === "upcoming" ? "default" : "secondary";
                    const hasCorrections = !!f.moderation && Object.keys(f.moderation.overrides ?? {}).length > 0;
                    const isEditing = editingFiringId === f.id;
                    return (
                      <div
                        key={f.id}
                        className={`rounded-md border p-3 ${f.moderation?.suppressed ? "border-amber-500/40 bg-amber-500/5" : "border-border"}`}
                        data-testid={`row-firing-${f.id}`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                          <div className="flex flex-wrap items-center gap-2 min-w-0">
                            <Badge variant={stateVariant} className="shrink-0" data-testid={`badge-firing-state-${f.id}`}>
                              {LIVE_ALERT_STATE_LABELS[displayState]}
                            </Badge>
                            {f.isCurrentBannerEvent ? (
                              <Badge variant="outline" className="border-primary/50 text-primary" data-testid={`badge-firing-current-banner-${f.id}`}>
                                Current banner
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-muted-foreground" data-testid={`badge-firing-historical-${f.id}`}>
                                Historical
                              </Badge>
                            )}
                            {f.moderation?.suppressed && (
                              <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-300" data-testid={`badge-firing-suppressed-${f.id}`}>
                                Suppressed
                              </Badge>
                            )}
                            {hasCorrections && (
                              <Badge variant="outline" data-testid={`badge-firing-corrected-${f.id}`}>Corrected</Badge>
                            )}
                            <span className="font-medium truncate" data-testid={`text-firing-leader-${f.id}`}>
                              {effective?.leader ?? f.leader}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground shrink-0">
                            <span className="flex items-center gap-1" data-testid={`text-firing-firedat-${f.id}`}>
                              <Clock className="w-3 h-3" />
                              {firedAt.toLocaleString()}
                            </span>
                            {durationLabel && (
                              <span className="flex items-center gap-1" data-testid={`text-firing-duration-${f.id}`}>
                                <Activity className="w-3 h-3" />
                                {durationLabel}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="text-sm text-foreground" data-testid={`text-firing-title-${f.id}`}>
                          {effective?.title ?? f.title}
                        </div>
                        {stateTime && (
                          <div className="mt-1 text-xs text-muted-foreground" data-testid={`text-firing-state-time-${f.id}`}>
                            {stateTimeLabel}: {formatLiveAlertTime(stateTime)}
                          </div>
                        )}
                        {(hasCorrections || f.moderation?.suppressed) && (
                          <div className="mt-1 rounded bg-muted/60 px-2 py-1 text-xs text-muted-foreground" data-testid={`text-firing-original-${f.id}`}>
                            Detector: {f.state} · {f.leader} · {f.title}
                            {f.watchUrl ? ` · ${f.watchUrl}` : ""}
                          </div>
                        )}
                        <div className="flex flex-wrap items-center justify-between gap-2 mt-1">
                          {f.source ? (
                            <span className="text-xs text-muted-foreground" data-testid={`text-firing-source-${f.id}`}>
                              Signal: {f.source}
                            </span>
                          ) : <span />}
                          <div className="ml-auto flex flex-wrap items-center gap-1.5">
                          {(effective?.watchUrl ?? f.watchUrl) && !f.moderation?.suppressed && (
                            <a
                              href={effective?.watchUrl ?? f.watchUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs text-primary inline-flex items-center gap-1 hover:underline"
                              data-testid={`link-firing-watch-${f.id}`}
                            >
                              <ExternalLink className="w-3 h-3" />
                              Watch
                            </a>
                          )}
                          {canModerateLiveAlerts && (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                onClick={() => beginLiveAlertEdit(f)}
                                data-testid={`button-edit-firing-${f.id}`}
                              >
                                <Pencil className="w-3 h-3 mr-1" /> Edit
                              </Button>
                              {f.moderation?.suppressed ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => beginLiveAlertAction(f, "restore")}
                                  data-testid={`button-restore-firing-${f.id}`}
                                >
                                  <Undo2 className="w-3 h-3 mr-1" /> Restore
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => beginLiveAlertAction(f, "hide")}
                                  data-testid={`button-hide-firing-${f.id}`}
                                >
                                  <EyeOff className="w-3 h-3 mr-1" /> Hide
                                </Button>
                              )}
                            </>
                          )}
                          </div>
                        </div>
                        {isEditing && liveAlertDraft && (
                          <div className="mt-3 border-t border-border pt-3 space-y-3" data-testid={`form-firing-moderation-${f.id}`}>
                            <div>
                              <div className="text-sm font-medium">
                                {liveAlertPendingAction === "edit" ? "Correct Live Watch alert" : liveAlertPendingAction === "hide" ? "Hide Live Watch alert" : "Restore Live Watch alert"}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {f.isCurrentBannerEvent
                                  ? "This event is currently powering the Curated banner. The detector output remains unchanged for audit."
                                  : "This is a historical event. Saving affects only this event key and will not change the current Curated banner."}
                              </div>
                            </div>
                            {liveAlertPendingAction === "edit" && (
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                <Select
                                  value={liveAlertDraft.state}
                                  onValueChange={(state: LiveAlertState) => setLiveAlertDraft({
                                    ...liveAlertDraft,
                                    state,
                                    startsAt: state === "upcoming" ? liveAlertDraft.startsAt : undefined,
                                    since: state === "live" ? liveAlertDraft.since : undefined,
                                    endsAt: state === "recently_ended" ? liveAlertDraft.endsAt : undefined,
                                  })}
                                >
                                  <SelectTrigger data-testid={`select-firing-state-${f.id}`}><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="upcoming">Starting soon</SelectItem>
                                    <SelectItem value="live">Live</SelectItem>
                                    <SelectItem value="recently_ended">Recently ended</SelectItem>
                                  </SelectContent>
                                </Select>
                                <Select
                                  value={liveAlertDraft.leader}
                                  onValueChange={(leader) => setLiveAlertDraft({ ...liveAlertDraft, leader })}
                                >
                                  <SelectTrigger data-testid={`select-firing-leader-${f.id}`}><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    {["President", "Vice President", "Secretary of State", "Secretary of War", "Chairman of the Joint Chiefs"].map((leader) => (
                                      <SelectItem key={leader} value={leader}>{leader}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <Input
                                  value={liveAlertDraft.title}
                                  onChange={(e) => setLiveAlertDraft({ ...liveAlertDraft, title: e.target.value })}
                                  placeholder="Alert title"
                                  className="sm:col-span-2"
                                  data-testid={`input-firing-title-${f.id}`}
                                />
                                <Input
                                  value={liveAlertDraft.watchUrl}
                                  onChange={(e) => setLiveAlertDraft({ ...liveAlertDraft, watchUrl: e.target.value })}
                                  placeholder="https://…"
                                  className="sm:col-span-2"
                                  data-testid={`input-firing-watch-url-${f.id}`}
                                />
                                {liveAlertDraft.state === "upcoming" && (
                                  <div>
                                    <label htmlFor={`input-firing-starts-at-${f.id}`} className="mb-1 block text-xs font-medium">Scheduled start (Starting soon)</label>
                                    <Input
                                      id={`input-firing-starts-at-${f.id}`}
                                      type="datetime-local"
                                      value={dateTimeLocalValue(liveAlertDraft.startsAt)}
                                      onChange={(e) => setLiveAlertDraft({ ...liveAlertDraft, startsAt: dateTimeIso(e.target.value) ?? undefined })}
                                      data-testid={`input-firing-starts-at-${f.id}`}
                                    />
                                  </div>
                                )}
                                {liveAlertDraft.state === "live" && (
                                  <div>
                                    <label htmlFor={`input-firing-since-${f.id}`} className="mb-1 block text-xs font-medium">Live since</label>
                                    <Input
                                      id={`input-firing-since-${f.id}`}
                                      type="datetime-local"
                                      value={dateTimeLocalValue(liveAlertDraft.since)}
                                      onChange={(e) => setLiveAlertDraft({ ...liveAlertDraft, since: dateTimeIso(e.target.value) ?? undefined })}
                                      data-testid={`input-firing-since-${f.id}`}
                                    />
                                  </div>
                                )}
                                {liveAlertDraft.state === "recently_ended" && (
                                  <div>
                                    <label htmlFor={`input-firing-ends-at-${f.id}`} className="mb-1 block text-xs font-medium">Ended at</label>
                                    <Input
                                      id={`input-firing-ends-at-${f.id}`}
                                      type="datetime-local"
                                      value={dateTimeLocalValue(liveAlertDraft.endsAt)}
                                      onChange={(e) => setLiveAlertDraft({ ...liveAlertDraft, endsAt: dateTimeIso(e.target.value) ?? undefined })}
                                      data-testid={`input-firing-ends-at-${f.id}`}
                                    />
                                  </div>
                                )}
                              </div>
                            )}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              <Select value={liveAlertReason || "__none"} onValueChange={(v) => setLiveAlertReason(v === "__none" ? "" : v)}>
                                <SelectTrigger data-testid={`select-firing-reason-${f.id}`}><SelectValue placeholder="Optional reason" /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none">No structured reason</SelectItem>
                                  {LIVE_ALERT_REASONS.map((reason) => (
                                    <SelectItem key={reason.key} value={reason.key}>{reason.label}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Textarea
                                value={liveAlertNote}
                                onChange={(e) => setLiveAlertNote(e.target.value)}
                                placeholder="Optional note"
                                maxLength={1000}
                                className="min-h-9"
                                data-testid={`input-firing-reason-note-${f.id}`}
                              />
                            </div>
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => { setEditingFiringId(null); setLiveAlertDraft(null); }}
                                disabled={liveAlertMutation.isPending}
                              >
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                variant={liveAlertPendingAction === "hide" ? "destructive" : "default"}
                                onClick={() => liveAlertMutation.mutate({
                                  firingId: f.id,
                                  action: liveAlertPendingAction,
                                  ...(liveAlertPendingAction === "edit" ? { fields: liveAlertDraft } : {}),
                                })}
                                disabled={
                                  liveAlertMutation.isPending ||
                                  (liveAlertPendingAction === "edit" && (
                                    !liveAlertDraft.title.trim() ||
                                    !liveAlertDraft.watchUrl.trim() ||
                                    (liveAlertDraft.state === "upcoming" && !liveAlertDraft.startsAt)
                                  ))
                                }
                                data-testid={`button-confirm-firing-${liveAlertPendingAction}-${f.id}`}
                              >
                                {liveAlertMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                                {liveAlertPendingAction === "edit" ? "Save correction" : liveAlertPendingAction === "hide" ? "Hide alert" : "Restore alert"}
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </TabsContent>

          {/* Adjustments tab — editorial evidence explorer (Task #1180) */}
          <TabsContent value="adjustments" className="flex flex-col flex-1 min-h-0 mt-3 data-[state=inactive]:hidden">
            <div className="text-xs text-muted-foreground mb-3 flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4" />
              What curated editors actually changed — collected as trustworthy training evidence for a human development agent to reason about. Read-only; nothing here approves, enforces, or auto-applies any rule.
            </div>
            {overrideLogLoading ? (
              <div className="flex items-center justify-center py-10 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : !overrideLog ? (
              <div className="text-sm text-muted-foreground py-10 text-center" data-testid="text-adjustments-unavailable">
                Adjustments log is unavailable.
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto space-y-4">
                {/* Capture controls + window summary */}
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
                  <div className="text-sm">
                    <span className="font-medium" data-testid="text-adjustments-total">
                      {overrideLog.report.totalEvents}
                    </span>
                    <span className="text-muted-foreground"> editor actions in the last {overrideLog.report.windowDays} days</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {overrideLog.capturePaused && (
                      <Badge variant="destructive" data-testid="badge-capture-paused">Capture paused</Badge>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pauseMutation.isPending}
                      onClick={() => pauseMutation.mutate(!overrideLog.capturePaused)}
                      data-testid="button-toggle-capture"
                    >
                      {pauseMutation.isPending ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : overrideLog.capturePaused ? (
                        <Play className="w-4 h-4 mr-2" />
                      ) : (
                        <Pause className="w-4 h-4 mr-2" />
                      )}
                      {overrideLog.capturePaused ? "Resume capture" : "Pause capture"}
                    </Button>
                    <Button
                      size="sm"
                      variant={showArchive ? "default" : "outline"}
                      onClick={() => setShowArchive((v) => !v)}
                      disabled={!overrideLog.acknowledgedAt}
                      data-testid="button-toggle-archive"
                      title={overrideLog.acknowledgedAt ? "View pre-reset actions" : "No reset recorded yet"}
                    >
                      <Archive className="w-4 h-4 mr-2" />
                      {showArchive ? "Current" : "Archive"}
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={resetMutation.isPending}
                          data-testid="button-reset-adjustments"
                        >
                          {resetMutation.isPending ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          ) : (
                            <RotateCcw className="w-4 h-4 mr-2" />
                          )}
                          Reset
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent data-testid="dialog-reset-adjustments">
                        <AlertDialogHeader>
                          <AlertDialogTitle>Reset the adjustments area?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This clears the current editor-action window so the evidence explorer
                            measures only fresh signal — use it after you've handed a packet to
                            development. Past actions are kept in the database for audit, just
                            hidden from this view.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel data-testid="button-cancel-reset">Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => resetMutation.mutate()}
                            data-testid="button-confirm-reset"
                          >
                            Reset
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
                {overrideLog.acknowledgedAt && (
                  <div className="text-xs text-muted-foreground -mt-2" data-testid="text-adjustments-reset-at">
                    Last reset {new Date(overrideLog.acknowledgedAt).toLocaleString()} — showing actions since.
                  </div>
                )}

                {/* Editorial evidence explorer (Task #1180) — filters drive both
                    the on-screen episode list and the copied Markdown packet. */}
                <div className="rounded-md border border-border p-3" data-testid="section-evidence-explorer">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <div className="text-sm font-medium flex items-center gap-2">
                      <Search className="w-4 h-4" />
                      Editorial evidence explorer
                    </div>
                    <Button
                      onClick={copyEvidencePacket}
                      disabled={copyingPacket}
                      data-testid="button-copy-development-packet"
                    >
                      {copyingPacket ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Copy className="w-4 h-4 mr-2" />}
                      Copy for development analysis
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">
                    Distinct editor episodes collected as evidence for a human development agent. Editor identity, credentials and secrets are excluded by contract. Nothing here is a standing rule or auto-enforced model.
                  </p>
                  {packetStatus && (
                    <div
                      className={`text-xs mb-3 rounded-md border px-2 py-1.5 ${packetStatus.ok ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-destructive/40 text-destructive"}`}
                      data-testid="text-packet-status"
                    >
                      {packetStatus.message}
                    </div>
                  )}

                  {/* Filters */}
                  <div className="space-y-3 border-t border-border pt-3">
                    {/* Date window */}
                    <div className="flex flex-wrap items-center gap-2" data-testid="filter-date-window">
                      <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">Date window</span>
                      {DATE_WINDOW_PRESETS.map((preset) => {
                        const presetSince = preset.days == null ? null : (nowMs ?? 0) - preset.days * 24 * 60 * 60 * 1000;
                        const active = evidenceFilters.since === presetSince;
                        return (
                          <Button
                            key={preset.key}
                            size="sm"
                            variant={active ? "default" : "outline"}
                            onClick={() => setEvidenceFilters((f) => ({ ...f, since: presetSince, until: null }))}
                            data-testid={`button-date-window-${preset.key}`}
                          >
                            {preset.label}
                          </Button>
                        );
                      })}
                    </div>

                    {/* Action families */}
                    <div className="flex flex-wrap items-center gap-2" data-testid="filter-action-families">
                      <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">Action families</span>
                      {ALL_ACTION_FAMILIES.map((fam) => {
                        const active = evidenceFilters.families.includes(fam);
                        return (
                          <Button
                            key={fam}
                            size="sm"
                            variant={active ? "default" : "outline"}
                            onClick={() =>
                              setEvidenceFilters((f) => ({
                                ...f,
                                families: active
                                  ? f.families.filter((x) => x !== fam)
                                  : [...f.families, fam],
                              }))
                            }
                            data-testid={`button-family-${fam}`}
                          >
                            {ACTION_FAMILY_LABELS[fam]}
                          </Button>
                        );
                      })}
                    </div>

                    {/* Toggles + scope */}
                    <div className="flex flex-wrap items-center gap-4">
                      <label className="flex items-center gap-2 text-xs cursor-pointer" data-testid="filter-commented-only">
                        <Checkbox
                          checked={evidenceFilters.commentedOnly}
                          onCheckedChange={(v) => setEvidenceFilters((f) => ({ ...f, commentedOnly: v === true }))}
                          data-testid="checkbox-commented-only"
                        />
                        <span>Commented only</span>
                      </label>
                      <label className="flex items-center gap-2 text-xs cursor-pointer" data-testid="filter-unresolved-only">
                        <Checkbox
                          checked={evidenceFilters.unresolvedOnly}
                          onCheckedChange={(v) => setEvidenceFilters((f) => ({ ...f, unresolvedOnly: v === true }))}
                          data-testid="checkbox-unresolved-only"
                        />
                        <span>Unresolved / contradictory</span>
                      </label>
                      <div className="flex items-center gap-2" data-testid="filter-scope">
                        <span className="text-xs font-medium text-muted-foreground">Scope</span>
                        <Button
                          size="sm"
                          variant={evidenceFilters.scope === "representative" ? "default" : "outline"}
                          onClick={() => setEvidenceFilters((f) => ({ ...f, scope: "representative" }))}
                          data-testid="button-scope-representative"
                        >
                          Representative
                        </Button>
                        <Button
                          size="sm"
                          variant={evidenceFilters.scope === "full" ? "default" : "outline"}
                          onClick={() => setEvidenceFilters((f) => ({ ...f, scope: "full" }))}
                          data-testid="button-scope-full"
                        >
                          Full evidence
                        </Button>
                      </div>
                    </div>
                  </div>

                  {/* Evidence counts — kept clearly separate from workload counts
                      and NEVER labeled as learning confidence. */}
                  {evidenceCounts && (
                    <div className="mt-3 border-t border-border pt-3" data-testid="section-evidence-counts">
                      <div className="text-xs text-muted-foreground mb-1">
                        Evidence volume in this filtered view (raw workload — not a confidence or quality score):
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                        <span data-testid="text-evidence-episode-count"><span className="font-medium text-foreground">{evidenceCounts.episodeCount}</span> distinct episodes</span>
                        <span data-testid="text-evidence-raw-count"><span className="font-medium text-foreground">{evidenceCounts.rawActionCount}</span> raw actions</span>
                        <span data-testid="text-evidence-included-count"><span className="font-medium text-foreground">{evidenceCounts.includedCount}</span> included</span>
                        <span data-testid="text-evidence-excluded-ambiguous-count"><span className="font-medium text-foreground">{evidenceCounts.excludedAmbiguousCount}</span> excluded (ambiguous/unverified)</span>
                        {evidenceCounts.excludedBySamplingCount > 0 && (
                          <span data-testid="text-evidence-excluded-sampling-count"><span className="font-medium text-foreground">{evidenceCounts.excludedBySamplingCount}</span> excluded (representative sampling)</span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Episode list */}
                  <div className="mt-3 border-t border-border pt-3" data-testid="section-evidence-episodes">
                    {evidenceLoading ? (
                      <div className="flex items-center justify-center py-6 text-muted-foreground">
                        <Loader2 className="w-5 h-5 animate-spin" />
                      </div>
                    ) : evidenceEpisodes.length === 0 ? (
                      <div className="text-sm text-muted-foreground py-4 text-center" data-testid="text-evidence-empty">
                        No editorial evidence matches these filters yet.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {evidenceEpisodes.map((ep) => (
                          <EvidenceEpisodeCard key={ep.episodeId} ep={ep} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Deterministic aggregated report */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <ReportList title="Most-relabeled topics" icon={<Tags className="w-4 h-4" />} items={overrideLog.report.topRelabeledFromTopic} testid="relabeled" />
                  <div className="rounded-md border border-border p-3">
                    <div className="text-sm font-medium flex items-center gap-2 mb-2">
                      <SlidersHorizontal className="w-4 h-4" /> Action breakdown
                    </div>
                    <div className="space-y-1">
                      {Object.entries(overrideLog.report.byAction)
                        .sort((a, b) => b[1] - a[1])
                        .map(([action, count]) => (
                          <div key={action} className="flex items-center justify-between text-sm" data-testid={`row-action-${action}`}>
                            <span className="text-muted-foreground">{OVERRIDE_ACTION_LABELS[action] ?? action}</span>
                            <span className="font-medium">{count}</span>
                          </div>
                        ))}
                      {Object.keys(overrideLog.report.byAction).length === 0 && (
                        <div className="text-sm text-muted-foreground">No actions yet.</div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Score-vs-action conflicts — where the AI's P-score disagreed
                    with the editor (the strongest scoring/threshold tuning cues). */}
                <div className="rounded-md border border-border p-3" data-testid="section-score-conflicts">
                  <div className="text-sm font-medium flex items-center gap-2 mb-2">
                    <SlidersHorizontal className="w-4 h-4" /> Score vs. editor conflicts
                    <span className="text-xs text-muted-foreground font-normal">
                      (threshold {overrideLog.report.scoreConflicts.scoreThreshold})
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <div className="flex items-center justify-between text-sm mb-1" data-testid="row-high-score-hides">
                        <span className="text-muted-foreground">High-score hides (AI over-scored)</span>
                        <span className="font-medium">{overrideLog.report.scoreConflicts.highScoreHides}</span>
                      </div>
                      {overrideLog.report.scoreConflicts.topHighScoreHideOutlets.map((it) => (
                        <div key={it.name} className="flex items-center justify-between text-xs text-muted-foreground" data-testid={`row-high-score-hide-outlet-${it.name}`}>
                          <span className="truncate">{it.name}</span>
                          <span>{it.count}</span>
                        </div>
                      ))}
                    </div>
                    <div>
                      <div className="flex items-center justify-between text-sm mb-1" data-testid="row-low-score-boosts">
                        <span className="text-muted-foreground">Low-score boosts (AI under-scored)</span>
                        <span className="font-medium">{overrideLog.report.scoreConflicts.lowScoreBoosts}</span>
                      </div>
                      {overrideLog.report.scoreConflicts.topLowScoreBoostOutlets.map((it) => (
                        <div key={it.name} className="flex items-center justify-between text-xs text-muted-foreground" data-testid={`row-low-score-boost-outlet-${it.name}`}>
                          <span className="truncate">{it.name}</span>
                          <span>{it.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Clustering-behavior changes — editor manual link/merge/unlink
                    of stories. A DISTINCT category from the scoring/relevance
                    signals above; feeds the clustering side of the AI brief. */}
                {(overrideLog.report.clusteringChanges?.total ?? 0) > 0 && (
                  <div className="rounded-md border border-border p-3" data-testid="section-clustering-changes">
                    <div className="text-sm font-medium flex items-center gap-2 mb-2">
                      <Link2 className="w-4 h-4" /> Clustering behavior changes
                      <span className="text-xs text-muted-foreground font-normal">
                        (manual grouping — informs clustering tuning)
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="flex items-center justify-between text-sm" data-testid="row-clustering-links">
                        <span className="text-muted-foreground">Links</span>
                        <span className="font-medium">{overrideLog.report.clusteringChanges?.links ?? 0}</span>
                      </div>
                      <div className="flex items-center justify-between text-sm" data-testid="row-clustering-merges">
                        <span className="text-muted-foreground">Merges</span>
                        <span className="font-medium">{overrideLog.report.clusteringChanges?.merges ?? 0}</span>
                      </div>
                      <div className="flex items-center justify-between text-sm" data-testid="row-clustering-unlinks">
                        <span className="text-muted-foreground">Unlinks</span>
                        <span className="font-medium">{overrideLog.report.clusteringChanges?.unlinks ?? 0}</span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="rounded-md border border-border p-3" data-testid="section-steering-attribution">
                  <div className="text-sm font-medium flex items-center gap-2 mb-1">
                    <Radar className="w-4 h-4" /> Steering attribution
                  </div>
                  <p className="text-xs text-muted-foreground mb-2">
                    Exact canonical URL matches within seven days only. Older or identity-less records remain uncorrelated.
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                    <div><span className="text-muted-foreground">Priority boosted</span><div className="font-medium" data-testid="steering-priority">{overrideLog.report.steering?.priorityBoosted ?? 0}</div></div>
                    <div><span className="text-muted-foreground">BOLO rescued</span><div className="font-medium" data-testid="steering-bolo">{overrideLog.report.steering?.boloRescued ?? 0}</div></div>
                    <div><span className="text-muted-foreground">U.S. implication</span><div className="font-medium" data-testid="steering-us">{overrideLog.report.steering?.usImplicationAdjusted ?? 0}</div></div>
                    <div><span className="text-muted-foreground">Uncorrelated</span><div className="font-medium" data-testid="steering-unknown">{overrideLog.report.steering?.uncorrelated ?? overrideLog.report.totalEvents}</div></div>
                  </div>
                </div>


                {/* Frozen legacy learned-rule inventory (Task #1180) — deprecated
                    speculative rules kept for audit only. There is NO approve or
                    enforce control and NO AI advisory brief; each item can only
                    be dispositioned (archive / discard / acknowledge). */}
                <div data-testid="section-legacy-learning" className="mb-4">
                  <div className="text-sm font-medium flex items-center gap-2 mb-1">
                    <Archive className="w-4 h-4" /> Frozen legacy learning inventory
                    <span className="text-xs text-muted-foreground font-normal">
                      (deprecated speculative rules — frozen, never enforced; audit + disposition only)
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-2">
                    These are the old auto-mined learned rules. They are frozen: none of them are applied to coverage, scoring, relevance, or clustering. Blast radius shows what each one <span className="italic">would have</span> touched, for context only.
                  </p>
                  {legacyLearningLoading ? (
                    <div className="flex items-center justify-center py-6 text-muted-foreground">
                      <Loader2 className="w-5 h-5 animate-spin" />
                    </div>
                  ) : legacyLearningItems.length === 0 ? (
                    <div className="text-sm text-muted-foreground py-4 text-center" data-testid="text-legacy-learning-empty">
                      No frozen legacy rules remain.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {legacyLearningItems.map((item) => {
                        const busy = dispositioningId === item.id;
                        const disposed = item.disposition != null;
                        return (
                          <div key={item.id} className="rounded-md border border-border p-2" data-testid={`row-legacy-learning-${item.id}`}>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex flex-wrap items-center gap-2 min-w-0">
                                <Badge variant="outline" className="shrink-0" data-testid={`badge-legacy-type-${item.id}`}>
                                  {LEGACY_RULE_TYPE_LABELS[item.ruleType] ?? item.ruleType}
                                </Badge>
                                <Badge variant="secondary" className="shrink-0" data-testid={`badge-legacy-frozen-${item.id}`}>
                                  Frozen
                                </Badge>
                                {disposed && (
                                  <Badge variant="outline" className="shrink-0" data-testid={`badge-legacy-disposition-${item.id}`}>
                                    {LEGACY_DISPOSITION_LABELS[item.disposition as LegacyDisposition] ?? item.disposition}
                                  </Badge>
                                )}
                              </div>
                              <span className="text-xs text-muted-foreground shrink-0" data-testid={`text-legacy-evidence-${item.id}`}>
                                {item.evidenceCount} correction{item.evidenceCount !== 1 ? "s" : ""}
                              </span>
                            </div>
                            <div className="text-sm text-foreground mt-1" data-testid={`text-legacy-label-${item.id}`}>
                              {item.label}
                            </div>
                            {item.blastRadius && (
                              <div className="text-xs text-muted-foreground mt-1" data-testid={`text-legacy-blast-radius-${item.id}`}>
                                Blast radius: {item.blastRadius.affectedCount} {item.blastRadius.affectedCount === 1 ? "item" : "items"}
                                {item.blastRadius.distinctStoryCount != null && ` across ${item.blastRadius.distinctStoryCount} distinct ${item.blastRadius.distinctStoryCount === 1 ? "story" : "stories"}`}
                                {item.blastRadius.windowDays != null && ` in the last ${item.blastRadius.windowDays} days`}
                                {item.blastRadius.basis && ` (${item.blastRadius.basis})`} — never applied.
                              </div>
                            )}
                            {disposed && (
                              <div className="text-xs text-muted-foreground mt-1" data-testid={`text-legacy-disposition-meta-${item.id}`}>
                                {LEGACY_DISPOSITION_LABELS[item.disposition as LegacyDisposition] ?? item.disposition} by {item.dispositionedBy ?? "unknown"}
                                {item.dispositionedAt ? ` on ${new Date(item.dispositionedAt).toLocaleString()}` : ""}
                              </div>
                            )}
                            <div className="flex items-center gap-2 mt-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => dispositionMutation.mutate({ id: item.id, disposition: "acknowledge" })}
                                data-testid={`button-legacy-acknowledge-${item.id}`}
                              >
                                {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}
                                Acknowledge
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => dispositionMutation.mutate({ id: item.id, disposition: "archive" })}
                                data-testid={`button-legacy-archive-${item.id}`}
                              >
                                <Archive className="w-4 h-4 mr-2" />
                                Archive
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => dispositionMutation.mutate({ id: item.id, disposition: "discard" })}
                                data-testid={`button-legacy-discard-${item.id}`}
                              >
                                <Trash2 className="w-4 h-4 mr-2" />
                                Discard
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Recent adjustments view — switches to pre-reset ARCHIVE when showArchive is on */}
                <div>
                  <div className="text-sm font-medium flex items-center gap-2 mb-2">
                    <Clock className="w-4 h-4" />
                    {showArchive ? "Pre-reset archive" : "Recent adjustments"}
                    {showArchive && overrideLog.acknowledgedAt && (
                      <span className="text-xs text-muted-foreground font-normal">
                        (before {new Date(overrideLog.acknowledgedAt).toLocaleString()})
                      </span>
                    )}
                  </div>
                  {showArchive && archiveLogLoading ? (
                    <div className="flex items-center justify-center py-6 text-muted-foreground">
                      <Loader2 className="w-5 h-5 animate-spin" />
                    </div>
                  ) : (showArchive ? (archiveLog?.recent ?? []) : overrideLog.recent).length === 0 ? (
                    <div className="text-sm text-muted-foreground py-6 text-center" data-testid="text-recent-empty">
                      {showArchive ? "No pre-reset actions found." : "No editor adjustments recorded yet."}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {(showArchive ? (archiveLog?.recent ?? []) : overrideLog.recent).map((e) => (
                        <div key={e.id} className="rounded-md border border-border p-2" data-testid={`row-adjustment-${e.id}`}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2 min-w-0">
                              <Badge variant="outline" className="shrink-0" data-testid={`badge-adjustment-action-${e.id}`}>
                                {OVERRIDE_ACTION_LABELS[e.action] ?? e.action}
                              </Badge>
                              {e.outlet && (
                                <span className="text-xs text-muted-foreground truncate">{e.outlet}</span>
                              )}
                            </div>
                            <span className="text-xs text-muted-foreground shrink-0 flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {e.createdAt ? new Date(e.createdAt as unknown as string).toLocaleString() : ""}
                            </span>
                          </div>
                          {e.headline && (
                            <div className="text-sm text-foreground mt-1 truncate" data-testid={`text-adjustment-headline-${e.id}`}>
                              {e.headline}
                            </div>
                          )}
                          {(e.contentKind || e.originalScore != null) && (
                            <div className="flex flex-wrap items-center gap-2 mt-1">
                              {e.contentKind && (
                                <Badge variant="secondary" className="shrink-0" data-testid={`badge-adjustment-contentkind-${e.id}`}>
                                  {e.contentKind}
                                </Badge>
                              )}
                              {e.originalScore != null && (
                                <span className="text-xs text-muted-foreground shrink-0" data-testid={`text-adjustment-score-${e.id}`}>
                                  AI score: {e.originalScore}
                                </span>
                              )}
                            </div>
                          )}
                          {e.originalReasoning && (
                            <div className="text-xs text-muted-foreground mt-1 line-clamp-2" data-testid={`text-adjustment-reasoning-${e.id}`}>
                              AI rationale: {e.originalReasoning}
                            </div>
                          )}
                          <div className="flex flex-wrap items-center justify-between gap-2 mt-1">
                            <span className="text-xs text-muted-foreground truncate">
                              {e.newValue ?? ""}
                            </span>
                            {e.editor && (
                              <span className="text-xs text-muted-foreground shrink-0">by {e.editor}</span>
                            )}
                          </div>
                          {/* Reason annotation (optional — editor may not have provided one) */}
                          {e.reasonKeys && e.reasonKeys.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1.5" data-testid={`section-adjustment-reasons-${e.id}`}>
                              {(e.reasonKeys as string[]).map((key: string) => {
                                const vocab = [...LINK_MERGE_REASONS, ...SCORE_ADJUST_REASONS, ...LIVE_ALERT_REASONS];
                                const match = vocab.find((r) => r.key === key);
                                return (
                                  <Badge key={key} variant="secondary" className="text-xs" data-testid={`badge-reason-${key}-${e.id}`}>
                                    {match?.label ?? key}
                                  </Badge>
                                );
                              })}
                            </div>
                          )}
                          {e.reasonNote && (
                            <p className="text-xs text-muted-foreground mt-1 italic" data-testid={`text-adjustment-reason-note-${e.id}`}>
                              {e.reasonNote}
                            </p>
                          )}
                          {(e.action === "live-alert-hide" || e.action === "live-alert-restore" || e.action === "live-alert-edit") &&
                            (e.beforeValue || e.afterValue) && (
                              <details className="mt-1.5 text-xs text-muted-foreground" data-testid={`details-adjustment-values-${e.id}`}>
                                <summary className="cursor-pointer hover:text-foreground">Before / after values</summary>
                                <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                                  <pre className="rounded bg-muted p-2 whitespace-pre-wrap break-all">
                                    Before{"\n"}{JSON.stringify(e.beforeValue ?? null, null, 2)}
                                  </pre>
                                  <pre className="rounded bg-muted p-2 whitespace-pre-wrap break-all">
                                    After{"\n"}{JSON.stringify(e.afterValue ?? null, null, 2)}
                                  </pre>
                                </div>
                              </details>
                            )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Manual link/merge audit trail — shows post-reset links in active mode,
                    pre-reset (archived) links in archive mode. Both are driven by the
                    same manualLinks query, which is parameterised by showArchive. */}
                <div>
                  <div className="text-sm font-medium flex items-center gap-2 mb-2">
                    <Link2 className="w-4 h-4" />
                    {showArchive ? "Pre-reset manual links" : "Manual links & merges"}
                    {!showArchive && activeManualLinks.length > 0 && (
                      <Badge variant="secondary" className="ml-1">{activeManualLinks.length} active</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mb-2">
                    {showArchive
                      ? "Manual links and merges from before the last reset."
                      : "Every manual link or merge an editor made. The AI's opinion is advisory — the editor's decision is what applied."}
                  </p>
                  {manualLinksLoading && (
                    <div className="text-sm text-muted-foreground">Loading…</div>
                  )}
                  {!manualLinksLoading && manualLinks.length === 0 && (
                    <div className="text-sm text-muted-foreground py-4 text-center" data-testid="text-no-editor-updates">
                      {showArchive ? "No pre-reset manual links found." : "No editor link/merge actions yet."}
                    </div>
                  )}
                  <div className="space-y-2">
                    {manualLinks.map((l) => (
                      <div
                        key={l.id}
                        className="rounded-md border border-border p-3 space-y-2"
                        data-testid={`row-editor-update-${l.id}`}
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline">{l.kind === "merge" ? "Merge" : "Link"}</Badge>
                          <Badge variant={l.status === "revoked" ? "secondary" : "outline"}>
                            {l.status === "revoked" ? "Revoked" : "Active"}
                          </Badge>
                          <Badge
                            variant={l.aiVerdict === "object" ? "destructive" : "secondary"}
                            title={l.aiReasoning || undefined}
                          >
                            AI: {l.aiVerdict === "concur" ? "Concurs" : l.aiVerdict === "object" ? "Objects" : "No opinion"}
                          </Badge>
                          {l.overrodeAi && (
                            <Badge variant="destructive" data-testid={`badge-overrode-${l.id}`}>
                              Editor overrode AI
                            </Badge>
                          )}
                          <span className="ml-auto text-xs text-muted-foreground font-mono">
                            {l.memberUrls?.length ?? 0} items
                          </span>
                        </div>
                        {l.label && <div className="text-sm leading-snug">{l.label}</div>}
                        {l.aiReasoning && (
                          <div className="text-xs text-muted-foreground">AI: {l.aiReasoning}</div>
                        )}
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-muted-foreground font-mono">
                            {l.createdBy || "editor"} ·{" "}
                            {(() => {
                              try {
                                return new Date(l.createdAt).toLocaleString();
                              } catch {
                                return l.createdAt;
                              }
                            })()}
                          </span>
                          {!showArchive && l.status === "active" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="ml-auto"
                              disabled={unlinkMutation.isPending}
                              onClick={() => unlinkMutation.mutate(l.id)}
                              data-testid={`button-unlink-${l.id}`}
                            >
                              Remove link
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </TabsContent>

          {/* Scoring & Relevance tab (Task #622) — read-only, live-derived. */}
          <TabsContent value="scoring" className="flex flex-col flex-1 min-h-0 mt-3 data-[state=inactive]:hidden">
            <div className="text-xs text-muted-foreground mb-3 flex items-center gap-2">
              <Gauge className="w-4 h-4" />
              Current main-feed priority-scoring bands and relevance gates. Read-only — reflects the live code, and updates automatically on republish.
            </div>
            {scoringRelevanceLoading ? (
              <div className="flex items-center justify-center py-10 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : !scoringRelevance ? (
              <div className="text-sm text-muted-foreground py-10 text-center" data-testid="text-scoring-unavailable">
                Scoring &amp; relevance data is unavailable.
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto space-y-4">
                {/* Priority-scoring ladder */}
                <div className="rounded-md border border-border p-3" data-testid="section-priority-ladder">
                  <div className="text-sm font-medium flex items-center gap-2 mb-2">
                    <Gauge className="w-4 h-4" /> Priority-scoring ladder
                    <Badge variant="outline" className="ml-1" data-testid="badge-active-rubric">
                      {scoringRelevance.activeRubric === "legacy" ? "Legacy rubric active" : "New rubric active"}
                    </Badge>
                  </div>
                  <div className="space-y-1.5">
                    {scoringRelevance.priorityBands.map((band, i) => {
                      const colorClass =
                        (band.tone && PRIORITY_BAND_TONE_CLASSES[band.tone]) ||
                        (band.min >= 90 ? PRIORITY_BAND_TONE_CLASSES.critical :
                        band.min >= 70 ? PRIORITY_BAND_TONE_CLASSES.high :
                        band.min >= 50 ? PRIORITY_BAND_TONE_CLASSES.moderate :
                        band.min >= 20 ? PRIORITY_BAND_TONE_CLASSES.low :
                        PRIORITY_BAND_TONE_CLASSES.minimal);
                      return (
                        <div
                          key={i}
                          className={`flex flex-wrap items-center gap-2 rounded-md border p-2 ${colorClass}`}
                          data-testid={`row-priority-band-${i}`}
                        >
                          <span className="text-xs font-mono font-medium shrink-0" data-testid={`text-band-range-${i}`}>
                            {band.min}–{band.max}
                          </span>
                          <span className="text-sm font-medium shrink-0" data-testid={`text-band-label-${i}`}>
                            {band.label}
                          </span>
                          {band.example && (
                            <span className="text-xs opacity-80 min-w-0" data-testid={`text-band-example-${i}`}>
                              {band.example}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Live score spread (Task #1093 follow-through) — the automated
                    replacement for the manual post-publish calibration audit:
                    band-by-band distribution of the last 7 days of RAW AI-assigned
                    main-feed scores, plus the most-repeated exact values
                    (favorite-number clumping) and an explicit empty-top-band flag. */}
                {(() => {
                  const dist = scoringRelevance.scoreDistribution;
                  if (!dist) return null;
                  const maxCount = Math.max(1, ...dist.bands.map((b) => b.count));
                  const topBandEmpty = dist.bands[dist.bands.length - 1]?.count === 0;
                  return (
                    <div className="rounded-md border border-border p-3" data-testid="section-score-distribution">
                      <div className="text-sm font-medium flex items-center gap-2 mb-1 flex-wrap">
                        <Gauge className="w-4 h-4" /> Live score spread
                        <Badge variant="outline" className="ml-1" data-testid="badge-score-spread-window">
                          {dist.totalScored} AI-scored · last {dist.windowDays} days
                        </Badge>
                        {topBandEmpty && dist.totalScored > 0 && (
                          <Badge
                            variant="outline"
                            className="text-orange-600 dark:text-orange-400 border-orange-500/40"
                            data-testid="badge-top-band-empty"
                          >
                            90–100 band empty this window
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mb-2">
                        Raw analyzer-assigned scores from the bot/RSS funnel (human overrides excluded). Healthy calibration
                        spreads across bands without repeating favorite values; an empty 90–100 band during a major ongoing
                        event is a calibration failure.
                      </p>
                      {dist.totalScored === 0 ? (
                        <div className="text-xs text-muted-foreground" data-testid="text-score-spread-empty">
                          No AI-scored items in this window yet.
                        </div>
                      ) : (
                        <>
                          <div className="space-y-1">
                            {dist.bands.map((band, i) => (
                              <div key={band.min} className="flex items-center gap-2" data-testid={`row-score-spread-band-${i}`}>
                                <span className="text-xs font-mono w-14 shrink-0 text-muted-foreground">
                                  {band.min}–{band.max}
                                </span>
                                <div className="flex-1 h-3 rounded-sm bg-muted overflow-hidden">
                                  <div
                                    className={`h-full rounded-sm ${
                                      band.min >= 90
                                        ? "bg-red-500/70"
                                        : band.min >= 70
                                        ? "bg-orange-500/70"
                                        : band.min >= 50
                                        ? "bg-yellow-500/70"
                                        : "bg-primary/40"
                                    }`}
                                    style={{
                                      width: `${Math.max(band.count > 0 ? 2 : 0, Math.round((band.count / maxCount) * 100))}%`,
                                    }}
                                  />
                                </div>
                                <span
                                  className="text-xs font-mono w-12 text-right shrink-0"
                                  data-testid={`text-score-spread-count-${i}`}
                                >
                                  {band.count}
                                </span>
                              </div>
                            ))}
                          </div>
                          {dist.topValues.length > 0 && (
                            <div className="mt-2">
                              <div className="text-xs text-muted-foreground mb-1">Most-assigned exact scores</div>
                              <div className="flex flex-wrap gap-1.5" data-testid="list-score-spread-top-values">
                                {dist.topValues.map((v) => (
                                  <Badge
                                    key={v.score}
                                    variant="secondary"
                                    className="font-mono"
                                    data-testid={`badge-score-spread-top-${v.score}`}
                                  >
                                    {v.score} ×{v.count} ({v.sharePct}%)
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}
                          <p className="text-[11px] text-muted-foreground mt-2" data-testid="text-score-spread-footnote">
                            {dist.humanOverrides} human override(s) · {dist.unscoredFallback} unscored fallback(s)
                            {(dist.otherScoreSources ?? 0) > 0 ? ` · ${dist.otherScoreSources} unknown-source excluded` : ""} in window
                          </p>
                        </>
                      )}
                    </div>
                  );
                })()}

                {/* Live current-context block (Task #1093) */}
                {scoringRelevance.currentContext && (
                  <div className="rounded-md border border-border p-3" data-testid="section-current-context">
                    <div className="text-sm font-medium flex items-center gap-2 mb-1">
                      <Gauge className="w-4 h-4" /> Current strategic context
                      <Badge
                        variant={scoringRelevance.currentContext.source === "disabled" ? "destructive" : "outline"}
                        className="ml-1"
                        data-testid="badge-current-context-source"
                      >
                        {scoringRelevance.currentContext.source === "auto"
                          ? "Auto-derived from live feed"
                          : scoringRelevance.currentContext.source === "date-only"
                          ? "Date only (feed picture unavailable)"
                          : "Disabled (kill switch)"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mb-2">
                      This block is appended to the analyzer prompt at scoring time so the AI knows today's date and the
                      current strategic picture (refreshed ~30 min from the last 48h of vetted high-priority reporting).
                    </p>
                    {scoringRelevance.currentContext.themes.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-2" data-testid="list-context-themes">
                        {scoringRelevance.currentContext.themes.map((t) => (
                          <Badge key={t.tag} variant="secondary" data-testid={`badge-context-theme-${t.tag}`}>
                            {t.tag} · {t.count}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {scoringRelevance.currentContext.adminNote && (
                      <p className="text-xs mb-2" data-testid="text-context-admin-note">
                        <span className="font-medium">Commander's note:</span> {scoringRelevance.currentContext.adminNote}
                      </p>
                    )}
                    {scoringRelevance.currentContext.block ? (
                      <pre
                        className="text-xs whitespace-pre-wrap rounded-md bg-muted p-2 max-h-48 overflow-y-auto"
                        data-testid="text-context-block"
                      >
                        {scoringRelevance.currentContext.block}
                      </pre>
                    ) : (
                      <p className="text-xs text-muted-foreground" data-testid="text-context-disabled">
                        The context block is currently disabled — the analyzer runs on the static rubric alone.
                      </p>
                    )}
                  </div>
                )}

                {/* Watch-topic steering cross-reference (Task #1094) */}
                {scoringRelevance.watchSteering && (
                  <div className="rounded-md border border-purple-500/40 bg-purple-500/5 p-3" data-testid="section-watch-steering-note">
                    <div className="text-sm font-medium flex items-center gap-2 mb-1 flex-wrap">
                      <Radar className="w-4 h-4" /> Watch-topic steering (Priority / BOLO)
                      <Badge
                        variant={scoringRelevance.watchSteering.enabled ? "default" : "secondary"}
                        data-testid="badge-watch-steering-state"
                      >
                        {scoringRelevance.watchSteering.enabled ? "Steering ON" : "Steering OFF"}
                      </Badge>
                      <Badge variant="outline" className="text-muted-foreground">Curated only</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mb-2" data-testid="text-watch-steering-note">
                      {scoringRelevance.watchSteering.note}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setActiveTab("watchtopics")}
                      data-testid="button-goto-watchtopics"
                    >
                      <Radar className="w-3.5 h-3.5 mr-1.5" />
                      Manage Priority / BOLO topics
                    </Button>
                  </div>
                )}

                {/* Per-pipeline scoring call sites (Task #624) */}
                <div className="rounded-md border border-border p-3" data-testid="section-scoring-callsites">
                  <div className="text-sm font-medium flex items-center gap-2 mb-1">
                    <Gauge className="w-4 h-4" /> Which rubric each scoring path uses
                  </div>
                  <p className="text-xs text-muted-foreground mb-2">
                    Every priority-scoring path reads the same active rubric, so the badge above applies to each feed pipeline below.
                  </p>
                  <div className="space-y-2">
                    {scoringRelevance.scoringCallSites.map((site) => (
                      <div
                        key={site.key}
                        className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border p-2"
                        data-testid={`row-callsite-${site.key}`}
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium" data-testid={`text-callsite-pipeline-${site.key}`}>
                            {site.pipeline}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5" data-testid={`text-callsite-feeds-${site.key}`}>
                            {site.feeds}
                          </div>
                          <code className="text-xs text-muted-foreground mt-0.5 inline-block" data-testid={`text-callsite-fn-${site.key}`}>
                            {site.fn}
                          </code>
                        </div>
                        <Badge
                          variant={site.honorsActiveRubric ? "outline" : "destructive"}
                          className="shrink-0"
                          data-testid={`badge-callsite-rubric-${site.key}`}
                        >
                          {site.rubric === "legacy"
                            ? "Legacy rubric"
                            : site.rubric === "new"
                            ? "New rubric"
                            : "Other rubric"}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Numeric gates */}
                <div className="rounded-md border border-border p-3" data-testid="section-scoring-gates">
                  <div className="text-sm font-medium flex items-center gap-2 mb-2">
                    <SlidersHorizontal className="w-4 h-4" /> Numeric gates
                  </div>
                  <div className="space-y-2">
                    {scoringRelevance.gates.map((gate) => (
                      <div
                        key={gate.key}
                        className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border p-2"
                        data-testid={`row-gate-${gate.key}`}
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium" data-testid={`text-gate-label-${gate.key}`}>{gate.label}</div>
                          <div className="text-xs text-muted-foreground mt-0.5" data-testid={`text-gate-description-${gate.key}`}>
                            {gate.description}
                          </div>
                        </div>
                        <Badge variant="secondary" className="shrink-0" data-testid={`badge-gate-value-${gate.key}`}>
                          {gate.value}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Applied learned scoring caps (Task #678) — the closed
                    editor-feedback loop: outlet×category caps the editors
                    approved, now enforced deterministically in the curated lane. */}
                <div className="rounded-md border border-border p-3" data-testid="section-learned-scoring-caps">
                  <div className="text-sm font-medium flex items-center gap-2 mb-2">
                    <SlidersHorizontal className="w-4 h-4" /> Applied learned scoring caps
                  </div>
                  {(scoringRelevance.learnedScoringCaps ?? []).length === 0 ? (
                    <div className="text-sm text-muted-foreground py-4 text-center" data-testid="text-learned-scoring-caps-empty">
                      No learned scoring caps applied yet. Approve a suggested "Scoring cap" rule in the Adjustments tab to enforce one here.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {(scoringRelevance.learnedScoringCaps ?? []).map((c, i) => (
                        <div
                          key={`${c.outlet}::${c.category}::${i}`}
                          className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border p-2"
                          data-testid={`row-learned-scoring-cap-${i}`}
                        >
                          <div className="min-w-0">
                            <div className="text-sm font-medium" data-testid={`text-learned-scoring-cap-label-${i}`}>
                              {c.outlet} × {c.category}
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5" data-testid={`text-learned-scoring-cap-detail-${i}`}>
                              Capped to ≤{c.cap ?? "—"} · {c.evidenceCount} editor {c.evidenceCount === 1 ? "signal" : "signals"}
                              {c.decidedBy ? ` · approved by ${c.decidedBy}` : ""}
                            </div>
                          </div>
                          <Badge variant="secondary" className="shrink-0" data-testid={`badge-learned-scoring-cap-value-${i}`}>
                            ≤{c.cap ?? "—"}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground/70 mt-2 italic" data-testid="text-learned-scoring-caps-note">
                    Curated-lane only, DOWN-only. Each cap is a human-approved rule mined from editors repeatedly hiding or down-pinning an outlet×category the AI over-scored — reversible any time by revoking it in the Adjustments tab.
                  </p>
                </div>

                {/* Relevance-filter summary */}
                <div className="rounded-md border border-border p-3" data-testid="section-relevance-gate">
                  <div className="text-sm font-medium flex items-center gap-2 mb-2">
                    <Eye className="w-4 h-4" /> Relevance filter
                    <Badge variant="outline" className="ml-1" data-testid="badge-relevance-rubric">
                      {scoringRelevance.relevanceGate.activeRubric}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground" data-testid="text-relevance-summary">
                    {scoringRelevance.relevanceGate.summary}
                  </p>
                  <p className="text-xs text-muted-foreground/70 mt-2 italic" data-testid="text-relevance-summary-note">
                    Plain-language synopsis of the active relevance prompt, maintained alongside the code. The active rubric, priority bands, and numeric gates above are derived live from the running configuration.
                  </p>
                </div>

                {/* Recent rule changes changelog */}
                <div className="rounded-md border border-border p-3" data-testid="section-rule-changelog">
                  <div className="text-sm font-medium flex items-center gap-2 mb-2">
                    <History className="w-4 h-4" /> Recent rule changes
                  </div>
                  {scoringRelevance.changelog.length === 0 ? (
                    <div className="text-sm text-muted-foreground py-4 text-center" data-testid="text-changelog-empty">
                      No rule changes recorded yet.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {scoringRelevance.changelog.map((entry, i) => (
                        <div key={i} className="rounded-md border border-border p-2" data-testid={`row-changelog-${i}`}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-medium" data-testid={`text-changelog-rule-${i}`}>{entry.rule}</span>
                            <span className="text-xs text-muted-foreground shrink-0" data-testid={`text-changelog-date-${i}`}>{entry.date}</span>
                          </div>
                          <div className="text-sm text-foreground mt-1" data-testid={`text-changelog-change-${i}`}>{entry.change}</div>
                          <div className="text-xs text-muted-foreground mt-1" data-testid={`text-changelog-reason-${i}`}>{entry.reason}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </TabsContent>

          {/* Priority / BOLO watch-topic management (Task #1094). The full
              management UI lives in WatchTopicManager — single home; the Team
              page now only shows a pointer here. */}
          <TabsContent value="watchtopics" className="flex flex-col flex-1 min-h-0 mt-3 data-[state=inactive]:hidden">
            <WatchTopicManager enabled={open && activeTab === "watchtopics"} />
          </TabsContent>

          {/* Feedback tab — viewer submissions inbox, editor-only read */}
          <TabsContent value="feedback" className="flex flex-col flex-1 min-h-0 mt-3 data-[state=inactive]:hidden">
            <div className="text-xs text-muted-foreground mb-3 flex items-center gap-2">
              <MessageSquare className="w-4 h-4" />
              Requests, suggestions, and questions submitted by Curated viewers. Marking an item reviewed archives it; delete removes it permanently.
            </div>

            {/* View toggle: Active (unreviewed) vs Archived (reviewed) */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <Button
                size="sm"
                variant={feedbackView === "active" ? "default" : "outline"}
                onClick={() => { setFeedbackView("active"); clearFeedbackSelection(); }}
                data-testid="button-feedback-view-active"
              >
                <MessageSquare className="w-3 h-3 mr-1" />
                Active
                {unreviewedFeedbackCount > 0 && (
                  <Badge variant="secondary" className="ml-2 no-default-hover-elevate">{unreviewedFeedbackCount}</Badge>
                )}
              </Button>
              <Button
                size="sm"
                variant={feedbackView === "archived" ? "default" : "outline"}
                onClick={() => { setFeedbackView("archived"); clearFeedbackSelection(); }}
                data-testid="button-feedback-view-archived"
              >
                <Archive className="w-3 h-3 mr-1" />
                Archived
                {archivedFeedbackCount > 0 && (
                  <Badge variant="secondary" className="ml-2 no-default-hover-elevate">{archivedFeedbackCount}</Badge>
                )}
              </Button>
            </div>

            {feedbackLoading ? (
              <div className="flex items-center justify-center py-10 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : displayedFeedback.length === 0 ? (
              <div className="text-sm text-muted-foreground py-10 text-center" data-testid="text-feedback-empty">
                {feedbackView === "active" ? "No active feedback. Nice work." : "No archived feedback yet."}
              </div>
            ) : (
              <>
                {/* Bulk action bar */}
                <div className="flex flex-wrap items-center gap-2 mb-3 pb-3 border-b border-border">
                  <div className="flex items-center gap-2 h-9 px-1">
                    <Checkbox
                      checked={allInViewSelected}
                      onCheckedChange={toggleSelectAllInView}
                      data-testid="checkbox-feedback-select-all"
                    />
                    <span className="text-xs text-muted-foreground">
                      {selectedInView.length > 0 ? `${selectedInView.length} selected` : "Select all"}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 ml-auto">
                    {feedbackView === "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={selectedInView.length === 0 || feedbackMutating}
                        onClick={() => bulkReviewFeedbackMutation.mutate(selectedInView)}
                        data-testid="button-feedback-bulk-review"
                      >
                        {bulkReviewFeedbackMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Archive className="w-3 h-3 mr-1" />}
                        Mark reviewed
                      </Button>
                    )}
                    {feedbackView === "archived" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={selectedInView.length === 0 || feedbackMutating}
                        onClick={() => selectedInView.forEach((id) => restoreFeedbackMutation.mutate(id))}
                        data-testid="button-feedback-bulk-restore"
                      >
                        <Undo2 className="w-3 h-3 mr-1" />
                        Restore
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={selectedInView.length === 0 || feedbackMutating}
                      onClick={() => setFeedbackDeleteTarget({ mode: "bulk", ids: selectedInView })}
                      data-testid="button-feedback-bulk-delete"
                    >
                      <Trash2 className="w-3 h-3 mr-1" />
                      Delete
                    </Button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto space-y-3">
                  {displayedFeedback.map((item) => (
                    <div
                      key={item.id}
                      className={`rounded-md border p-3 space-y-2 ${item.reviewed ? "border-border opacity-70" : "border-border"}`}
                      data-testid={`feedback-item-${item.id}`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={selectedFeedbackIds.has(item.id)}
                            onCheckedChange={() => toggleFeedbackSelected(item.id)}
                            data-testid={`checkbox-feedback-${item.id}`}
                          />
                          <Badge variant="outline" className="capitalize text-xs" data-testid={`badge-feedback-type-${item.id}`}>
                            {item.feedbackType}
                          </Badge>
                          {item.reviewed ? (
                            <Badge variant="secondary" className="text-xs gap-1">
                              <Check className="w-3 h-3" /> Reviewed
                            </Badge>
                          ) : (
                            <Badge variant="destructive" className="text-xs">Unreviewed</Badge>
                          )}
                          {item.wantsFollowUp && !item.anonymous && (
                            <Badge variant="outline" className="text-xs">Follow-up requested</Badge>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground font-mono">
                          {(() => { try { return new Date(item.submittedAt).toLocaleString(); } catch { return item.submittedAt; } })()}
                        </span>
                      </div>
                      <p className="text-sm whitespace-pre-wrap" data-testid={`text-feedback-message-${item.id}`}>{item.message}</p>
                      <div className="text-xs text-muted-foreground">
                        {item.anonymous ? (
                          <span className="italic">Anonymous</span>
                        ) : (
                          <span>
                            {[item.contactName, item.contactEmail, item.contactOrg].filter(Boolean).join(" · ") || "No contact details"}
                          </span>
                        )}
                      </div>
                      {item.reviewed && item.reviewedBy && (
                        <div className="text-xs text-muted-foreground font-mono">
                          Reviewed by {item.reviewedBy}
                          {item.reviewedAt ? ` · ${(() => { try { return new Date(item.reviewedAt).toLocaleString(); } catch { return item.reviewedAt; } })()}` : ""}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        {!item.reviewed ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={feedbackMutating}
                            onClick={() => reviewFeedbackMutation.mutate(item.id)}
                            data-testid={`button-mark-reviewed-${item.id}`}
                          >
                            {reviewFeedbackMutation.isPending && reviewFeedbackMutation.variables === item.id ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Archive className="w-3 h-3 mr-1" />}
                            Mark reviewed
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={feedbackMutating}
                            onClick={() => restoreFeedbackMutation.mutate(item.id)}
                            data-testid={`button-restore-${item.id}`}
                          >
                            {restoreFeedbackMutation.isPending && restoreFeedbackMutation.variables === item.id ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Undo2 className="w-3 h-3 mr-1" />}
                            Restore
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          disabled={feedbackMutating}
                          onClick={() => setFeedbackDeleteTarget({ mode: "single", id: item.id })}
                          data-testid={`button-delete-feedback-${item.id}`}
                        >
                          <Trash2 className="w-3 h-3 mr-1" />
                          Delete
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Delete confirmation (single + bulk) */}
            <AlertDialog open={feedbackDeleteTarget !== null} onOpenChange={(o) => { if (!o) setFeedbackDeleteTarget(null); }}>
              <AlertDialogContent data-testid="dialog-delete-feedback">
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {feedbackDeleteTarget?.mode === "bulk"
                      ? `Delete ${feedbackDeleteTarget.ids.length} feedback item${feedbackDeleteTarget.ids.length === 1 ? "" : "s"}?`
                      : "Delete this feedback item?"}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently removes the feedback. This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel data-testid="button-delete-feedback-cancel">Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => {
                      if (!feedbackDeleteTarget) return;
                      if (feedbackDeleteTarget.mode === "bulk") bulkDeleteFeedbackMutation.mutate(feedbackDeleteTarget.ids);
                      else deleteFeedbackMutation.mutate(feedbackDeleteTarget.id);
                      setFeedbackDeleteTarget(null);
                    }}
                    data-testid="button-delete-feedback-confirm"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// Small reusable ranked-count list for the deterministic override report.
function ReportList({ title, icon, items, testid }: { title: string; icon: React.ReactNode; items: OverrideReportCount[]; testid: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-sm font-medium flex items-center gap-2 mb-2">{icon} {title}</div>
      {items.length === 0 ? (
        <div className="text-sm text-muted-foreground">No data yet.</div>
      ) : (
        <div className="space-y-1">
          {items.map((it) => (
            <div key={it.name} className="flex items-center justify-between gap-2 text-sm" data-testid={`row-report-${testid}-${it.name}`}>
              <span className="text-muted-foreground truncate">{it.name}</span>
              <span className="font-medium shrink-0">{it.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// One distinct editorial-evidence episode (Task #1180). Read-only: shows the
// semantic reason, normalized story example, before/requested/actual, truthful
// lifecycle/persistence, contradiction + supersede/undo lineage, provenance and
// source URLs. Never presents any approve/enforce control.
function EvidenceEpisodeCard({ ep }: { ep: EvidenceEpisode }) {
  const isPriority = ep.family === "priority";
  const persisted = ep.persisted ?? (ep.outcome === "persisted" || ep.outcome === "applied");
  const contradictory = ep.outcome === "conflicted" || ep.contradictsEpisodeId != null;
  return (
    <div className="rounded-md border border-border p-2" data-testid={`row-evidence-episode-${ep.episodeId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Badge variant="outline" className="shrink-0" data-testid={`badge-evidence-action-${ep.episodeId}`}>
            {ACTION_KIND_LABELS[ep.action] ?? ep.action}
          </Badge>
          <Badge variant="secondary" className="shrink-0" data-testid={`badge-evidence-family-${ep.episodeId}`}>
            {ACTION_FAMILY_LABELS[ep.family] ?? ep.family}
          </Badge>
          {ep.label !== "none" && (
            <Badge
              variant={ep.label === "negative" ? "destructive" : ep.label === "positive" ? "default" : "outline"}
              className="shrink-0"
              data-testid={`badge-evidence-label-${ep.episodeId}`}
            >
              {GROUPING_LABEL_LABELS[ep.label] ?? ep.label}
            </Badge>
          )}
          {contradictory && (
            <Badge variant="destructive" className="shrink-0" data-testid={`badge-evidence-contradictory-${ep.episodeId}`}>
              Contradictory
            </Badge>
          )}
        </div>
        {/* Raw collapse count is workload only — not a confidence signal. */}
        <span className="text-xs text-muted-foreground shrink-0" data-testid={`text-evidence-rawcount-${ep.episodeId}`}>
          {ep.rawCount} raw action{ep.rawCount !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Semantic reason */}
      <div className="text-sm text-foreground mt-1" data-testid={`text-evidence-reason-${ep.episodeId}`}>
        {reasonLabel(ep.reason)}
      </div>
      {ep.note && (
        <p className="text-xs text-muted-foreground mt-1 italic" data-testid={`text-evidence-note-${ep.episodeId}`}>
          {ep.note}
        </p>
      )}

      {/* Normalized story example */}
      <div className="text-xs text-muted-foreground mt-1 font-mono break-all" data-testid={`text-evidence-story-${ep.episodeId}`}>
        Story: {ep.story || "(none)"}
      </div>
      {ep.headlines.length > 0 && (
        <div className="mt-1 space-y-0.5" data-testid={`section-evidence-headlines-${ep.episodeId}`}>
          {ep.headlines.slice(0, 4).map((h, i) => (
            <div key={i} className="text-xs text-foreground truncate" data-testid={`text-evidence-headline-${ep.episodeId}-${i}`}>
              {h}
            </div>
          ))}
        </div>
      )}
      {ep.memberOutlets.length > 0 && (
        <div className="text-xs text-muted-foreground mt-1" data-testid={`text-evidence-outlets-${ep.episodeId}`}>
          Outlets: {ep.memberOutlets.join(", ")}
        </div>
      )}

      {/* Before / requested / actual (priority family) */}
      {isPriority && (ep.before != null || ep.requested != null || ep.actual != null) && (
        <div className="text-xs text-muted-foreground mt-1" data-testid={`text-evidence-scores-${ep.episodeId}`}>
          Score before/requested/actual: {ep.before ?? "–"} → {ep.requested ?? "–"} → {ep.actual ?? "–"} ({ep.direction})
        </div>
      )}

      {/* Truthful lifecycle / persistence */}
      <div className="flex flex-wrap items-center gap-2 mt-1.5">
        <Badge variant="outline" className="text-xs" data-testid={`badge-evidence-outcome-${ep.episodeId}`}>
          {OUTCOME_LABELS[ep.outcome] ?? ep.outcome}
        </Badge>
        <span className="text-xs text-muted-foreground" data-testid={`text-evidence-persistence-${ep.episodeId}`}>
          {persisted ? "Still in effect" : "Not persisted / reverted"}
        </span>
        <span className="text-xs text-muted-foreground" data-testid={`text-evidence-verified-${ep.episodeId}`}>
          {ep.verified ? "Verified" : "Unverified"}
        </span>
      </div>

      {/* Contradiction + supersede / undo lineage */}
      {(ep.supersedesEpisodeId || ep.supersededByEpisodeId || ep.contradictsEpisodeId) && (
        <div className="text-xs text-muted-foreground mt-1 space-y-0.5" data-testid={`section-evidence-lineage-${ep.episodeId}`}>
          {ep.supersedesEpisodeId && (
            <div data-testid={`text-evidence-supersedes-${ep.episodeId}`}>Supersedes/undoes: <span className="font-mono">{ep.supersedesEpisodeId}</span></div>
          )}
          {ep.supersededByEpisodeId && (
            <div data-testid={`text-evidence-superseded-by-${ep.episodeId}`}>Superseded by: <span className="font-mono">{ep.supersededByEpisodeId}</span></div>
          )}
          {ep.contradictsEpisodeId && (
            <div data-testid={`text-evidence-contradicts-${ep.episodeId}`}>Contradicts: <span className="font-mono">{ep.contradictsEpisodeId}</span></div>
          )}
        </div>
      )}

      {/* Provenance */}
      {ep.provenance && (ep.provenance.model || ep.provenance.promptVersion || ep.provenance.clusterRevision || ep.provenance.surface) && (
        <div className="text-xs text-muted-foreground mt-1" data-testid={`text-evidence-provenance-${ep.episodeId}`}>
          Provenance: model={ep.provenance.model ?? "–"} · prompt={ep.provenance.promptVersion ?? "–"} · clusterRev={ep.provenance.clusterRevision ?? "–"} · surface={ep.provenance.surface ?? "–"}
        </div>
      )}

      {/* Source URLs */}
      {ep.memberUrls.length > 0 && (
        <div className="mt-1.5 space-y-0.5" data-testid={`section-evidence-urls-${ep.episodeId}`}>
          {ep.memberUrls.slice(0, 6).map((u, i) => (
            <a
              key={i}
              href={u}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground break-all"
              data-testid={`link-evidence-url-${ep.episodeId}-${i}`}
            >
              <ExternalLink className="w-3 h-3 shrink-0" />
              {u}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
