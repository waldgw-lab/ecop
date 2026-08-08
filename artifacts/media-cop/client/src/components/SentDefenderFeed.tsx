import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ExternalLink } from "lucide-react";
import { formatCuratedPostTime, formatShareDateTime } from "@/lib/postTime";
import { useTimezone } from "@/lib/timezone";
import CuratedSocialCardAction from "@/components/CuratedSocialCardAction";
import { escapeHtml } from "@/lib/richCopy";
import { CURATED_FEED_SCALE, type CuratedFeedScale } from "@/lib/curatedFeedScale";

interface OsintFeedPost {
  id: string;
  postId: string;
  content: string;
  postedAt: Date | string;
  xUrl: string;
  sourceAccount: string;
  originalAccount?: string | null;
  imageUrl?: string | null;
  videoUrl?: string | null;
}

interface SentDefenderFeedProps {
  posts: OsintFeedPost[];
  // Optional, backward-compatible overrides used only by the curated view.
  // When an entry exists for a post's sourceAccount, render a circular image
  // avatar / custom display name instead of the default initials + @handle.
  // When omitted (Dashboard, Stream, War, CustomMcop), behavior is unchanged.
  avatarMap?: Record<string, string>;
  nameMap?: Record<string, string>;
  // "curated" renders the Truth-Social-style header (name · @handle on one line,
  // relative time · full DTG, normalized text-xs fonts). Defaults to "default"
  // to keep every other surface (Dashboard, Stream, War, CustomMcop) unchanged.
  variant?: "default" | "curated";
  // Empty-state text. Defaults to the OSINT wording so every existing surface is
  // unchanged; the curated "Press X Feed" pane passes its own label so an empty
  // press column no longer reads "No OSINT posts available".
  emptyLabel?: string;
  // Curated-only avatar/text sizing for the Curated social bloc's 3/2/1 column
  // switcher (Task #252). Ignored unless variant === "curated".
  scale?: CuratedFeedScale;
  canAttachSocialPosts?: boolean;
  findAttachedStory?: (identityUrl: string) => { title: string } | null;
  onOpenAttachedStory?: (identityUrl: string) => void;
}

const ACCOUNT_STYLES: Record<string, { initials: string; label: string; bgClass: string }> = {
  sentdefender: { initials: 'SD', label: '@sentdefender', bgClass: 'bg-primary' },
  MATA_osint: { initials: 'MA', label: '@MATA_osint', bgClass: 'bg-amber-600' },
  CENTCOM: { initials: 'CC', label: '@CENTCOM', bgClass: 'bg-slate-600' },
  SOUTHCOM: { initials: 'SC', label: '@SOUTHCOM', bgClass: 'bg-teal-600' },
  Osint613: { initials: 'OS', label: '@Osint613', bgClass: 'bg-indigo-600' },
  Osinttechnical: { initials: 'OT', label: '@Osinttechnical', bgClass: 'bg-rose-600' },
  FirstSquawk: { initials: 'FS', label: '@FirstSquawk', bgClass: 'bg-cyan-600' },
  AggregateOsint: { initials: 'OA', label: '@AggregateOsint', bgClass: 'bg-violet-600' },
  // Journalists X Feed (Task #182) — curated-lane-only handles.
  BarakRavid: { initials: 'BR', label: '@BarakRavid', bgClass: 'bg-blue-600' },
  jeremybob1: { initials: 'YB', label: '@jeremybob1', bgClass: 'bg-orange-600' },
  phildstewart: { initials: 'PS', label: '@phildstewart', bgClass: 'bg-green-600' },
  EricSchmittNYT: { initials: 'ES', label: '@EricSchmittNYT', bgClass: 'bg-purple-600' },
  alexbward: { initials: 'AW', label: '@alexbward', bgClass: 'bg-red-600' },
};

const FLIGHT_TRACKING_STYLE = { initials: 'FT', bgClass: 'bg-emerald-600' };

function formatTimestamp(date: Date | string): string {
  const postDate = new Date(date);
  const now = new Date();
  
  const isToday = postDate.getDate() === now.getDate() &&
                  postDate.getMonth() === now.getMonth() &&
                  postDate.getFullYear() === now.getFullYear();
  
  if (isToday) {
    return postDate.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    });
  }
  
  const diffMs = now.getTime() - postDate.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  
  if (diffHours < 168) {
    return postDate.toLocaleString('en-US', { 
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }
  
  return postDate.toLocaleString('en-US', { 
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

function curatedDisplayName(label: string) {
  const sep = label.indexOf(" · ");
  return sep === -1 ? label : label.slice(0, sep);
}

function curatedHandle(label: string) {
  const sep = label.indexOf(" · ");
  return sep === -1 ? label : label.slice(sep + 3);
}

// Build the rich-copy HTML payload for a curated Press/OSINT X post: bold +
// hyperlinked author line, an absolute date-time, the post body, and an
// [IMAGE] marker when the post carries an image. Mirrors the X / Truth feeds.
function buildSentDefenderCopyHtml(post: OsintFeedPost, displayLabel: string, tz: string): string {
  const name = curatedDisplayName(displayLabel);
  const handle = curatedHandle(displayLabel);
  const line1 = name && name !== handle ? `${name} · ${handle}` : handle;
  const lines: string[] = [];
  lines.push(
    `<div><b><a href="${escapeHtml(post.xUrl)}">${escapeHtml(line1)}</a></b></div>`,
  );
  const when = formatShareDateTime(post.postedAt, tz);
  if (when) lines.push(`<div>${escapeHtml(when)}</div>`);
  if (post.content) {
    lines.push(`<div>${escapeHtml(post.content).replace(/\n/g, "<br>")}</div>`);
  }
  if (post.imageUrl) lines.push(`<div>[IMAGE]</div>`);
  return lines.join("");
}

export default function SentDefenderFeed({ posts, avatarMap, nameMap, variant = "default", emptyLabel = "No OSINT posts available", scale, canAttachSocialPosts = false, findAttachedStory, onOpenAttachedStory }: SentDefenderFeedProps) {
  const tz = useTimezone();
  const sc = variant === "curated" && scale ? CURATED_FEED_SCALE[scale] : null;
  const avatarCls = sc?.avatar ?? "h-8 w-8";
  const authorCls = sc?.author ?? "text-[11px]";
  const metaCls = sc?.meta ?? "text-[10px]";
  const contentCls = sc?.content ?? "text-[11px]";
  if (posts.length === 0) {
    return (
      <div className="text-sm text-muted-foreground" data-testid="text-no-sentdefender-posts">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {posts.map((post) => {
        const isFlightTracking = post.sourceAccount === 'flightTracking';
        const style = isFlightTracking
          ? { initials: FLIGHT_TRACKING_STYLE.initials, label: `@${post.originalAccount || 'unknown'}`, bgClass: FLIGHT_TRACKING_STYLE.bgClass }
          : (ACCOUNT_STYLES[post.sourceAccount] || ACCOUNT_STYLES.sentdefender);
        // sentdefender_posts rows have no sourceAccount column, so fall back to
        // 'sentdefender' when keying the curated avatar/name overrides.
        const acctKey = isFlightTracking ? post.sourceAccount : (post.sourceAccount || 'sentdefender');
        const avatarUrl = avatarMap?.[acctKey];
        const displayLabel = nameMap?.[acctKey] ?? style.label;
        const card = (
          <Card 
            key={post.id} 
            className={`p-3 hover-elevate active-elevate-2 cursor-pointer transition-all${variant === "curated" ? " shadow-md shadow-black/30" : ""}`}
            data-testid={`card-sentdefender-post-${post.postId}`}
            onClick={() => window.open(post.xUrl, '_blank')}
          >
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <div className="flex-shrink-0">
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt={displayLabel}
                      className={`${avatarCls} rounded-full object-cover bg-white`}
                    />
                  ) : (
                    <div className={`${avatarCls} rounded-full ${style.bgClass} flex items-center justify-center text-white text-xs font-bold`}>
                      {style.initials}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className={variant === "curated" ? "min-w-0" : undefined}>
                      <div className={`font-semibold ${variant === "curated" ? `${authorCls} truncate` : "text-xs"}`} data-testid="text-sentdefender-author">
                        {variant === "curated" ? curatedDisplayName(displayLabel) : displayLabel}
                      </div>
                      <div className={`text-muted-foreground ${variant === "curated" ? metaCls : "text-xs font-mono"}`} data-testid={`text-sentdefender-timestamp-${post.postId}`}>
                        {variant === "curated"
                          ? formatCuratedPostTime(post.postedAt, tz)
                          : formatTimestamp(post.postedAt)}
                      </div>
                    </div>
                    {variant === "curated" ? (
                      <div className="flex items-center gap-0.5 flex-shrink-0">
                        <CuratedSocialCardAction
                          editor={canAttachSocialPosts}
                          identityUrl={post.xUrl}
                          attachedStoryTitle={findAttachedStory?.(post.xUrl)?.title}
                          onOpenAttachedStory={() => onOpenAttachedStory?.(post.xUrl)}
                          copyTestId={`button-copy-sentdefender-${post.postId}`}
                          copyLabel="Copy post to clipboard"
                          buildHtml={() => buildSentDefenderCopyHtml(post, displayLabel, tz)}
                        />
                      </div>
                    ) : (
                      <ExternalLink className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    )}
                  </div>
                </div>
              </div>
              
              <div className={`${variant === "curated" ? `leading-snug ${contentCls}` : "leading-relaxed text-sm"}`} data-testid={`text-sentdefender-content-${post.postId}`}>
                {post.content.split('\n').map((line, i) => {
                  if (line.startsWith('RT @')) {
                    return <span key={i} className="block mt-2 text-xs text-muted-foreground italic border-l-2 border-muted pl-2">{line}</span>;
                  }
                  if (line.trim() === '') return null;
                  return <span key={i} className="block">{line}</span>;
                })}
              </div>
            </div>
          </Card>
        );
        if (variant === "curated") {
          return (
            <Tooltip key={post.id}>
              <TooltipTrigger asChild>{card}</TooltipTrigger>
              <TooltipContent
                side="top"
                align="start"
                className="px-2 py-0.5 text-[10px] font-normal text-muted-foreground"
              >
                @{curatedHandle(displayLabel).replace(/^@/, "")}
              </TooltipContent>
            </Tooltip>
          );
        }
        return card;
      })}
    </div>
  );
}
