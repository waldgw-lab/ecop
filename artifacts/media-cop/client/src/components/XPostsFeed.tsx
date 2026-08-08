import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ExternalLink, Repeat2 } from "lucide-react";
import type { XPost } from "@shared/schema";
import xLogoUrl from "@assets/x-logo.png";
import { formatCuratedPostTime, formatShareDateTime } from "@/lib/postTime";
import { useTimezone } from "@/lib/timezone";
import CuratedSocialCardAction from "@/components/CuratedSocialCardAction";
import { escapeHtml } from "@/lib/richCopy";
import { CURATED_FEED_SCALE, type CuratedFeedScale } from "@/lib/curatedFeedScale";

interface XPostsFeedProps {
  posts: XPost[];
  // Optional handle->image map for real profile avatars. When omitted (e.g. the
  // main Dashboard), the feed falls back to its original text-initial avatars,
  // so existing MCOP behavior is unchanged.
  avatarMap?: Record<string, string>;
  // Optional handle->display label map ("Display Name · @handle"). Used only by
  // the curated view; when omitted the feed shows the original "@handle".
  nameMap?: Record<string, string>;
  // Optional handle->initials map for the text-avatar fallback (used when no
  // avatarMap image exists). Curated-only; when omitted the original 'SW'/'PH'
  // fallback is used so existing surfaces are unchanged.
  initialsMap?: Record<string, string>;
  // "curated" renders the Truth-Social-style header (name · @handle on one line,
  // relative time · full DTG, normalized text-xs fonts). Defaults to "default"
  // to keep every other surface (Dashboard, etc.) unchanged.
  variant?: "default" | "curated";
  // Curated-only avatar/text sizing for the Curated social bloc's 3/2/1 column
  // switcher (Task #252). Ignored unless variant === "curated".
  scale?: CuratedFeedScale;
  canAttachSocialPosts?: boolean;
  findAttachedStory?: (identityUrl: string) => { title: string } | null;
  onOpenAttachedStory?: (identityUrl: string) => void;
}

function formatTimestamp(date: Date): string {
  const postDate = new Date(date);
  const now = new Date();
  
  // Check if post is from today (same calendar day)
  const isToday = postDate.getDate() === now.getDate() &&
                  postDate.getMonth() === now.getMonth() &&
                  postDate.getFullYear() === now.getFullYear();
  
  // If from today, show time only
  if (isToday) {
    return postDate.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    });
  }
  
  // Check if within the last 7 days
  const diffMs = now.getTime() - postDate.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  
  // If less than 7 days (but not today), show day and time
  if (diffHours < 168) {
    return postDate.toLocaleString('en-US', { 
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }
  
  // Older posts show full date
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
  const handle = sep === -1 ? label : label.slice(sep + 3);
  return `@${handle.replace(/^@/, "")}`;
}

// Build the rich-copy HTML payload for a curated X post: bold + hyperlinked
// author/handle line, an absolute date-time, the post body, and an [IMAGE]
// marker when the post carries an image.
function buildXCopyHtml(post: XPost, authorLabel: string, tz: string): string {
  const name = curatedDisplayName(authorLabel);
  const handle = curatedHandle(authorLabel);
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

export default function XPostsFeed({ posts, avatarMap, nameMap, initialsMap, variant = "default", scale, canAttachSocialPosts = false, findAttachedStory, onOpenAttachedStory }: XPostsFeedProps) {
  const tz = useTimezone();
  const sc = variant === "curated" && scale ? CURATED_FEED_SCALE[scale] : null;
  const avatarCls = sc?.avatar ?? "h-8 w-8";
  const authorCls = sc?.author ?? "text-[11px]";
  const metaCls = sc?.meta ?? "text-[10px]";
  const contentCls = sc?.content ?? "text-[11px]";
  if (posts.length === 0) {
    return (
      <div className="text-sm text-muted-foreground" data-testid="text-no-posts">
        No X posts available
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {posts.map((post) => {
        const authorLabel = !post.isRetweet && nameMap?.[post.sourceAccount]
          ? nameMap[post.sourceAccount]
          : `@${post.isRetweet && post.retweetedFrom ? post.retweetedFrom : (post.sourceAccount || 'SecWar')}`;
        const card = (
        <Card 
          key={post.id} 
          className={`p-3 hover-elevate active-elevate-2 cursor-pointer transition-all${
            variant === "curated" ? " shadow-md shadow-black/30 curated-feed-card" : ""
          }`}
          data-testid={`card-x-post-${post.postId}`}
          onClick={() => window.open(post.xUrl, '_blank')}
        >
          <div className="space-y-2">
            {/* Retweet indicator - shown above the post */}
            {post.isRetweet && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground" data-testid={`retweet-indicator-${post.postId}`}>
                <Repeat2 className="h-3 w-3" />
                <span>@{post.sourceAccount} reposted</span>
              </div>
            )}
            
            <div className="flex items-start gap-2">
              <div className="flex-shrink-0">
                {!post.isRetweet && avatarMap?.[post.sourceAccount] ? (
                  <img
                    src={avatarMap[post.sourceAccount]}
                    alt={`@${post.sourceAccount}`}
                    className={`${avatarCls} rounded-full object-cover bg-white`}
                    data-testid={`img-x-avatar-${post.postId}`}
                  />
                ) : variant === "curated" && post.isRetweet ? (
                  <img
                    src={xLogoUrl}
                    alt="X repost"
                    className={`${avatarCls} rounded-full object-cover bg-black`}
                    data-testid={`img-x-retweet-${post.postId}`}
                  />
                ) : (
                  <div className={`${avatarCls} rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold`}>
                    {post.isRetweet && post.retweetedFrom 
                      ? post.retweetedFrom.substring(0, 2).toUpperCase()
                      : initialsMap?.[post.sourceAccount] ?? (post.sourceAccount === 'PeteHegseth' ? 'PH' : 'SW')}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className={variant === "curated" ? "min-w-0" : undefined}>
                    <div className={`flex items-center gap-1.5${variant === "curated" ? " min-w-0" : ""}`}>
                      <span className={`font-semibold ${variant === "curated" ? `${authorCls} min-w-0 break-words` : "text-xs"}`} data-testid="text-author">
                        {variant === "curated" ? curatedDisplayName(authorLabel) : authorLabel}
                      </span>
                      {/* RT badge is redundant in the curated view, which already
                          shows the "@account reposted" header — so it's omitted
                          there. Other variants (e.g. Dashboard) keep it. The
                          retweet metadata/header are unaffected either way. */}
                      {post.isRetweet && variant !== "curated" && (
                        <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 flex-shrink-0" data-testid={`badge-retweet-${post.postId}`}>
                          RT
                        </Badge>
                      )}
                    </div>
                    <div className={`text-muted-foreground ${variant === "curated" ? metaCls : "text-xs font-mono"}`} data-testid={`text-timestamp-${post.postId}`}>
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
                        copyTestId={`button-copy-x-${post.postId}`}
                        copyLabel="Copy post to clipboard"
                        buildHtml={() => buildXCopyHtml(post, authorLabel, tz)}
                      />
                    </div>
                  ) : (
                    <ExternalLink className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                  )}
                </div>
              </div>
            </div>
            
            <div className={`${variant === "curated" ? `leading-snug ${contentCls} whitespace-pre-wrap` : "leading-relaxed text-sm"}`} data-testid={`text-content-${post.postId}`}>
              {variant === "curated" ? post.content.replace(/\n{3,}/g, "\n\n") : post.content}
            </div>
            {variant === "curated" && post.imageUrl && (
              <div
                className="overflow-hidden rounded-md border border-border/70 bg-muted/30"
                data-testid={`attachment-x-post-${post.postId}`}
                onClick={(event) => event.stopPropagation()}
              >
                <img
                  src={post.imageUrl}
                  alt={`Image attached to ${curatedHandle(authorLabel)} post`}
                  loading="lazy"
                  className="block max-h-52 w-full object-contain"
                  onError={(event) => {
                    event.currentTarget.parentElement?.remove();
                  }}
                />
              </div>
            )}
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
                {curatedHandle(authorLabel)}
              </TooltipContent>
            </Tooltip>
          );
        }
        return card;
      })}
    </div>
  );
}
