import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import Login from "@/pages/Login";
import {
  ArrowLeft,
  Archive,
  Search,
  BookOpen,
  ExternalLink,
  Film,
  Headphones,
  MessageSquareQuote,
  Radio,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { OutletRegistry } from "@shared/schema";
import { buildOutletIndex, findOutlet, type OutletIndex } from "@shared/outletRegistry";
import { deriveContentType, type ContentKind } from "@shared/contentKind";
import OutletLogo from "@/components/OutletLogo";
import articleFallbackImg from "@assets/image_1780977866532.png";

// =============================================================================
// CURATED VIEW — Story Archive (curated-view ONLY).
//
// A searchable archive of historical clustered stories preserved across the
// per-pass member wipe. Reads ONLY the curated-gated /api/curated/archive +
// /api/curated/outlets endpoints and renders each story the SAME way the live
// Curated feed renders a clustered story (card -> rich detail pop-out), with two
// deliberate differences for the archival context:
//   • every relative "X ago" indicator is shown as an absolute date + time, and
//   • the live feed's "Updated" line is replaced by a status indicator —
//     "Phased out {lastSeenAt}" when the story genuinely aged out, or
//     "Active — not currently in Top Stories" when its articles are still fresh
//     and it simply isn't surfaced right now (server-derived `status`).
//
// This page is intentionally SELF-CONTAINED: it reuses the genuinely shared
// modules (outletRegistry / contentKind / outletLogos) but keeps its own small
// presentational helpers so the reviewed live Curated feed is never touched and
// the curated lane stays isolated/fail-closed.
// =============================================================================

const PAGE_SIZE = 30;

interface ArchiveMember {
  source: string;
  title: string;
  url: string;
  behaviorClass: string;
  behaviorLabel: string | null;
  spin: string | null;
  // Article's publication date/time (ISO string) snapshotted at archive time.
  // Absent/null for sources with an unknown date or rows archived before this
  // was captured — rendered only when present (never fabricated).
  publishedAt?: string | null;
}

interface ArchiveStory {
  id: string;
  signature: string;
  headline: string;
  lede: string;
  facts: string[];
  // Curated lane (Task #256) — attributed claims / key statements preserved
  // alongside the synthesized facts; rendered additively, never folded into
  // Corroborated Facts. Empty array hides the section.
  attributedClaims: string[];
  category: string | null;
  region: string | null;
  country: string | null;
  sourceCount: number;
  repTitle: string | null;
  repSource: string | null;
  repUrl: string | null;
  ogImageUrl: string | null;
  members: ArchiveMember[];
  firstSeenAt: string;
  lastSeenAt: string;
  // Honest archive status (server-derived). 'active' = the story's articles are
  // still fresh and it remains eligible — it simply isn't currently surfaced in
  // Top Stories (crowded out by the priority cap or a transient missed pass);
  // 'phased_out' = it genuinely aged out at lastSeenAt.
  // 'superseded' = the story is live in Top Stories right now under a newer
  // grouping; this archived row is the older version it replaced.
  status: "active" | "phased_out" | "superseded";
}

interface ArchiveResponse {
  items: ArchiveStory[];
  total: number;
  limit: number;
  offset: number;
}

// -----------------------------------------------------------------------------
// Outlet registry context (logos / origin). Mirrors the live feed: read ONLY in
// this curated-gated page; never joined by any shared feed.
// -----------------------------------------------------------------------------
const OutletIndexContext = createContext<OutletIndex | null>(null);
function useOutlet(source: string, url?: string | null): OutletRegistry | undefined {
  const index = useContext(OutletIndexContext);
  return index ? findOutlet(index, source, url) : undefined;
}

// -----------------------------------------------------------------------------
// Small presentational helpers (kept local so the live feed isn't touched).
// -----------------------------------------------------------------------------
// A favicon/clearbit fallback must never masquerade as an article photo; swap in
// a neutral storm-cloud default instead. TASS-style outlets that publish their
// logo AS the share image are treated the same.
function isFaviconImage(u: string | null | undefined): boolean {
  return (
    !!u &&
    (u.includes("gstatic.com/faviconV2") ||
      u.includes("logo.clearbit.com") ||
      u.includes("/favicon"))
  );
}
const LOGO_SHARE_IMAGE_OUTLETS = new Set(["tass"]);
function isLogoShareOutlet(source: string | null | undefined): boolean {
  return !!source && LOGO_SHARE_IMAGE_OUTLETS.has(source.trim().toLowerCase());
}
function resolveArticleImage(
  u: string | null | undefined,
  allowFallback = true,
  source?: string | null,
): string | null {
  if (!u) return allowFallback ? articleFallbackImg : null;
  if (isFaviconImage(u) || isLogoShareOutlet(source)) {
    return allowFallback ? articleFallbackImg : null;
  }
  return u;
}

function abbreviateGeo(label: string): string {
  const t = label.trim();
  if (/^(the\s+)?united states(\s+of\s+america)?$/i.test(t)) return "U.S.";
  if (/^u\.?\s*s\.?\s*a?\.?$/i.test(t)) return "U.S.";
  if (/^(the\s+)?united kingdom(\s+of\s+great\s+britain(\s+and\s+northern\s+ireland)?)?$/i.test(t)) return "UK";
  if (/^u\.?\s*k\.?$/i.test(t)) return "UK";
  return t;
}
function toTopic(category: string | null): string {
  const trimmed = (category ?? "").trim();
  if (!trimmed) return "—";
  const isAllCaps = trimmed === trimmed.toUpperCase();
  const isAllLower = trimmed === trimmed.toLowerCase();
  if (!isAllCaps && !isAllLower) return trimmed;
  return trimmed
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
function geoLabel(s: ArchiveStory): string | null {
  const raw = (s.country && s.country.trim()) || (s.region && s.region.trim());
  return raw ? abbreviateGeo(raw) : null;
}

// Absolute date + time, matching the live feed's "9:03 PM 12 Jun 26" style.
function formatDateTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const dd = String(d.getDate()).padStart(2, "0");
  const mmm = d.toLocaleString("en-US", { month: "short" });
  const yy = String(d.getFullYear()).slice(-2);
  return `${time} ${dd} ${mmm} ${yy}`;
}

// Same trust-tier split the live detail view uses, derived from the snapshot's
// stamped behavior class/label (no live role fallback — archived members always
// carry a behavior class).
function tierOf(m: ArchiveMember): "contributing" | "contrast" | "attached" {
  const cls = m.behaviorClass;
  if (!cls) return "attached";
  if (cls === "corroborating") return "contributing";
  if (cls === "anchor-only") return m.behaviorLabel === "contrast" ? "contrast" : "contributing";
  return "attached";
}

// Outlet logo (real logo when registered, else a light initials circle).
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

function ContentKindBadge({ kind }: { kind: ContentKind }) {
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

// One contributing/contrast/attached source row — outlet logo, name, content-kind
// badge, the source's own publication date/time (when captured), the outlet's own
// headline (click-out), and its spin. Per-member bullets/summaries are still
// omitted; a missing date is simply not shown (never fabricated).
function ArticleRow({ m, storyId, i }: { m: ArchiveMember; storyId: string; i: number }) {
  const kind = deriveContentType(m.url);
  const inner = (
    <>
      <SourceIcon source={m.source} url={m.url} sizeClass="h-8 w-8" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono text-muted-foreground shrink-0">{m.source}</span>
          {(m.behaviorLabel || m.behaviorClass) && tierOf(m) === "contrast" && (
            <Badge variant="outline" className="capitalize">
              {m.behaviorLabel || m.behaviorClass}
            </Badge>
          )}
          <ContentKindBadge kind={kind} />
          {m.publishedAt && (
            <span
              className="text-xs font-mono text-muted-foreground shrink-0 ml-auto"
              data-testid={`text-detail-date-${storyId}-${i}`}
            >
              {formatDateTime(m.publishedAt)}
            </span>
          )}
        </div>
        <div className="text-sm leading-snug mt-0.5">{m.title}</div>
        {m.spin && (
          <div
            className="text-xs italic text-muted-foreground leading-snug mt-1"
            data-testid={`text-detail-spin-${storyId}-${i}`}
          >
            {m.spin}
          </div>
        )}
      </div>
    </>
  );
  return m.url ? (
    <a
      href={m.url}
      target="_blank"
      rel="noreferrer"
      className="flex items-start gap-2.5 rounded-md p-2 hover-elevate"
      data-testid={`row-detail-article-${storyId}-${i}`}
    >
      {inner}
    </a>
  ) : (
    <div className="flex items-start gap-2.5 rounded-md p-2" data-testid={`row-detail-article-${storyId}-${i}`}>
      {inner}
    </div>
  );
}

// Rich detail pop-out — mirrors the live feed's StoryDetailDialog, but wider
// (max-w-5xl vs the feed's max-w-3xl) so it has more room to expand horizontally.
function StoryDetailDialog({ story, onClose }: { story: ArchiveStory | null; onClose: () => void }) {
  const geo = story ? geoLabel(story) : null;
  const heroImage = story ? resolveArticleImage(story.ogImageUrl, true, story.repSource) : null;
  const contributing = story ? story.members.filter((m) => tierOf(m) === "contributing") : [];
  const contrast = story ? story.members.filter((m) => tierOf(m) === "contrast") : [];
  const attached = story ? story.members.filter((m) => tierOf(m) === "attached") : [];

  return (
    <Dialog open={!!story} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-w-5xl w-[95vw] max-h-[90vh] overflow-y-auto border-2 border-curated-accent/50"
        data-testid="dialog-archive-detail"
      >
        {story && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-xs font-mono font-semibold" data-testid="text-detail-topic">
                  {toTopic(story.category)}
                </span>
                {geo && (
                  <>
                    <span className="text-xs text-muted-foreground font-mono">·</span>
                    <span className="text-xs font-mono" data-testid="text-detail-region">
                      {geo}
                    </span>
                  </>
                )}
                <span className="text-xs text-muted-foreground font-mono" data-testid="text-detail-firstseen">
                  · First seen {formatDateTime(story.firstSeenAt)}
                </span>
                {story.status === "superseded" ? (
                  <span className="text-xs text-muted-foreground font-mono" data-testid="text-detail-status">
                    · Superseded — newer version live in Top Stories
                  </span>
                ) : story.status === "active" ? (
                  <span className="text-xs text-muted-foreground font-mono" data-testid="text-detail-status">
                    · Active — not currently in Top Stories
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground font-mono" data-testid="text-detail-phasedout">
                    · Archived {formatDateTime(story.lastSeenAt)}
                  </span>
                )}
                <span className="text-xs text-muted-foreground font-mono" data-testid="text-detail-sources">
                  · {story.sourceCount} {story.sourceCount === 1 ? "source" : "sources"}
                </span>
              </div>
              <DialogTitle className="text-xl leading-snug text-left" data-testid="text-detail-title">
                {story.headline?.trim() || story.repTitle?.trim() || "Untitled story"}
              </DialogTitle>
            </DialogHeader>

            {heroImage && (
              <img
                src={heroImage}
                alt=""
                loading="lazy"
                className="w-full h-72 rounded-md bg-muted object-cover"
                data-testid="img-detail"
              />
            )}

            {story.lede && (
              <p className="text-base leading-relaxed" data-testid="text-detail-lede">
                {story.lede}
              </p>
            )}

            {story.facts.length > 0 && (
              <div data-testid="list-detail-facts">
                <h4 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-2">
                  Corroborated Facts
                </h4>
                <ul className="list-disc pl-5 space-y-1.5">
                  {story.facts.map((f, i) => (
                    <li key={i} className="text-sm leading-relaxed">
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Curated lane (Task #256) — attributed claims / key statements.
                ADDITIVE section kept separate from Corroborated Facts; each line
                preserves its source attribution. Hidden when empty. */}
            {story.attributedClaims && story.attributedClaims.length > 0 && (
              <div className="mt-4" data-testid="list-detail-attributed-claims">
                <h4 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-2">
                  Attributed Claims & Key Statements
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

            <div className="space-y-4">
              {contributing.length > 0 && (
                <div>
                  <h4 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-2 mt-1">
                    {contributing.length}{" "}
                    {contributing.length === 1 ? "Contributing Source" : "Contributing Sources"}
                  </h4>
                  <div className="space-y-1.5" data-testid="list-detail-contributing">
                    {contributing.map((m, i) => (
                      <ArticleRow key={`c-${i}`} m={m} storyId={story.id} i={i} />
                    ))}
                  </div>
                </div>
              )}

              {contrast.length > 0 && (
                <div>
                  <h4 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-2">
                    {contrast.length} {contrast.length === 1 ? "Contrast Source" : "Contrast Sources"}
                    <span className="ml-2 font-normal normal-case text-xs text-muted-foreground">
                      (shown for contrast / spin — never alters the corroborated facts)
                    </span>
                  </h4>
                  <div className="space-y-1.5" data-testid="list-detail-contrast">
                    {contrast.map((m, i) => (
                      <ArticleRow key={`x-${i}`} m={m} storyId={story.id} i={i} />
                    ))}
                  </div>
                </div>
              )}

              {attached.length > 0 && (
                <div>
                  <h4 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-2">
                    {attached.length} Additional Coverage
                    <span className="ml-2 font-normal normal-case text-xs text-muted-foreground">
                      (attached / non-contributing)
                    </span>
                  </h4>
                  <div className="space-y-1.5" data-testid="list-detail-attached">
                    {attached.map((m, i) => (
                      <ArticleRow key={`a-${i}`} m={m} storyId={story.id} i={i} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Feed-style collapsed card: meta line, headline, 2-line lede, thumbnail.
function StoryCard({ story, onOpen }: { story: ArchiveStory; onOpen: () => void }) {
  const geo = geoLabel(story);
  const title = story.headline?.trim() || story.repTitle?.trim() || "Untitled story";
  const thumb = resolveArticleImage(story.ogImageUrl, true, story.repSource);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left rounded-md border bg-card text-card-foreground p-4 hover-elevate"
      data-testid={`card-archive-${story.id}`}
    >
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-mono text-muted-foreground">
            <span className="font-semibold text-foreground" data-testid={`text-topic-${story.id}`}>
              {toTopic(story.category)}
            </span>
            {geo && (
              <>
                <span>·</span>
                <span>{geo}</span>
              </>
            )}
            <span>·</span>
            {story.status === "superseded" ? (
              <span data-testid={`text-status-${story.id}`}>
                Superseded — newer version live in Top Stories
              </span>
            ) : story.status === "active" ? (
              <span data-testid={`text-status-${story.id}`}>
                Active — not currently in Top Stories
              </span>
            ) : (
              <span data-testid={`text-phasedout-${story.id}`}>
                Archived {formatDateTime(story.lastSeenAt)}
              </span>
            )}
            <span>·</span>
            <span data-testid={`text-sources-${story.id}`}>
              {story.sourceCount} {story.sourceCount === 1 ? "source" : "sources"}
            </span>
          </div>
          <h2
            className="text-base font-semibold leading-snug mt-1.5"
            data-testid={`text-headline-${story.id}`}
          >
            {title}
          </h2>
          {story.lede && (
            <p className="text-sm text-muted-foreground leading-relaxed mt-1.5 line-clamp-2">
              {story.lede}
            </p>
          )}
        </div>
        {thumb && (
          <img
            src={thumb}
            alt=""
            loading="lazy"
            className="hidden sm:block h-20 w-32 rounded-md object-cover bg-muted shrink-0"
            data-testid={`img-thumb-${story.id}`}
          />
        )}
      </div>
    </button>
  );
}

export default function CuratedArchive() {
  const { data: curatedAccess, isLoading: accessLoading } = useQuery<{
    hasCuratedAccess: boolean;
    canView?: boolean;
  }>({
    queryKey: ["/api/auth/curated-access"],
    retry: false,
  });
  // View access rides `canView` (any app-password login), with hasCuratedAccess
  // kept as a backward-compat alias. Logged-out visitors are shown the MCOP
  // password login in-place (see the render gate below) rather than bounced away.
  const hasAccess = curatedAccess?.canView ?? curatedAccess?.hasCuratedAccess;

  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ArchiveStory | null>(null);

  // Debounce the search box; reset to the first page on a new query.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(searchInput.trim());
      setPage(0);
    }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const offset = page * PAGE_SIZE;
  const enabled = hasAccess === true;

  const { data, isLoading, isFetching } = useQuery<ArchiveResponse>({
    queryKey: ["/api/curated/archive", { q: query, limit: PAGE_SIZE, offset }],
    enabled,
  });

  // Outlet registry (logos) — curated-gated, same source the live feed uses.
  const { data: outlets = [] } = useQuery<OutletRegistry[]>({
    queryKey: ["/api/curated/outlets"],
    enabled,
  });
  const outletIndex = useMemo(() => buildOutletIndex(outlets), [outlets]);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + items.length, total);

  const showEmpty = useMemo(
    () => enabled && !isLoading && items.length === 0,
    [enabled, isLoading, items.length],
  );

  if (accessLoading) {
    return (
      <div className="dark min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Not logged in (or the app session expired): show the MCOP password login in
  // place on /curated/archive. After a successful login the access check refetches,
  // canView flips true, and the archive renders — matching the /curated flow.
  if (hasAccess !== true) {
    return (
      <Login
        onLoginSuccess={() =>
          queryClient.invalidateQueries({ queryKey: ["/api/auth/curated-access"] })
        }
      />
    );
  }

  return (
    <OutletIndexContext.Provider value={outletIndex}>
      <div className="curated-root min-h-screen bg-background text-foreground">
        <div className="curated-sheet max-w-5xl mx-auto px-4 py-5">
          {/* Return / back button — top-left. */}
          <div className="mb-5">
            <Link href="/curated">
              <Button variant="ghost" size="sm" className="gap-2" data-testid="button-back-curated">
                <ArrowLeft className="h-4 w-4" />
                Back to Curated
              </Button>
            </Link>
          </div>

          <header className="mb-5">
            <div className="flex items-center gap-2">
              <Archive className="h-5 w-5 text-muted-foreground" />
              <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-archive-title">
                Story Archive
              </h1>
            </div>
            <p className="text-sm text-muted-foreground mt-1.5">
              Past stories, kept here after they dropped out of the live Curated feed. Click any
              story to open the full detail.
            </p>
          </header>

          {/* Search */}
          <div className="relative mb-5">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search headlines, summaries, sources…"
              className="pl-9"
              data-testid="input-search-archive"
            />
          </div>

          {/* Result count */}
          {enabled && !isLoading && (
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-muted-foreground" data-testid="text-result-count">
                {total === 0 ? "No stories found" : `Showing ${rangeStart}–${rangeEnd} of ${total}`}
              </span>
              {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </div>
          )}

          {/* List */}
          {isLoading || accessLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : showEmpty ? (
            <div className="text-center py-16 text-sm text-muted-foreground" data-testid="text-empty">
              {query
                ? "No archived stories match your search."
                : "No archived stories yet. Stories appear here as they are clustered."}
            </div>
          ) : (
            <div className="space-y-3">
              {items.map((story) => (
                <StoryCard key={story.id} story={story} onOpen={() => setSelected(story)} />
              ))}
            </div>
          )}

          {/* Pagination */}
          {enabled && total > PAGE_SIZE && (
            <div className="flex items-center justify-between gap-2 mt-6">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0 || isFetching}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                data-testid="button-prev-page"
              >
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">
                Page {page + 1} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page + 1 >= totalPages || isFetching}
                onClick={() => setPage((p) => p + 1)}
                data-testid="button-next-page"
              >
                Next
              </Button>
            </div>
          )}
        </div>
      </div>

      <StoryDetailDialog story={selected} onClose={() => setSelected(null)} />
    </OutletIndexContext.Provider>
  );
}
