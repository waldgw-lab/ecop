import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ExternalLink, Play } from "lucide-react";
import type { TruthSocialPost } from "@shared/schema";
import { cleanTruthContent } from "@/lib/cleanTruthContent";
import { formatCuratedPostTime, formatShareDateTime } from "@/lib/postTime";
import { useTimezone } from "@/lib/timezone";
import { useState } from "react";
import CuratedSocialCardAction from "@/components/CuratedSocialCardAction";
import OutletLogo from "@/components/OutletLogo";
import {
  POTUS_TRUTH_SOCIAL_CANONICAL_NAME,
  POTUS_TRUTH_SOCIAL_LOGO_SLUG,
} from "@/lib/outletLogos";
import { escapeHtml } from "@/lib/richCopy";
import { CURATED_FEED_SCALE, type CuratedFeedScale } from "@/lib/curatedFeedScale";

// Build the rich-copy HTML payload for a curated Truth Social post: bold +
// hyperlinked author/handle line, an absolute date-time, the cleaned body, and
// an [IMAGE]/[VIDEO] marker when the post carries media.
function buildTruthCopyHtml(post: TruthSocialPost, tz: string): string {
  const lines: string[] = [];
  lines.push(
    `<div><b><a href="${escapeHtml(post.truthSocialUrl)}">${escapeHtml(
      "Donald J. Trump · @realDonaldTrump",
    )}</a></b></div>`,
  );
  const when = formatShareDateTime(post.postedAt, tz);
  if (when) lines.push(`<div>${escapeHtml(when)}</div>`);
  const body = cleanTruthContent(post.content);
  if (body && body !== "[Media attachment]") {
    lines.push(`<div>${escapeHtml(body).replace(/\n/g, "<br>")}</div>`);
  }
  const marker = post.videoUrl ? "[VIDEO]" : post.imageUrl ? "[IMAGE]" : "";
  if (marker) lines.push(`<div>${marker}</div>`);
  return lines.join("");
}

interface TruthSocialFeedProps {
  posts: TruthSocialPost[];
  // When true, render images like the Visual (Stream) view: drop logo/favicon
  // "junk" attachments and hide tiny/sliver images. Defaults to false to keep
  // existing surfaces (e.g. Dashboard) unchanged.
  filterJunkImages?: boolean;
  // "curated" renders the Twitter-style header (Truth icon + name · @handle,
  // relative time · full timestamp). Defaults to "default" to keep every other
  // surface (Dashboard, etc.) unchanged.
  variant?: "default" | "curated";
  // Curated-only avatar/text sizing for the Curated social bloc's 3/2/1 column
  // switcher (Task #252). Ignored unless variant === "curated".
  scale?: CuratedFeedScale;
  // Curated editor mode replaces the direct copy glyph with an equal-footprint
  // action arrow. Public/non-Curated surfaces keep the existing direct copy.
  canAttachSocialPosts?: boolean;
  findAttachedStory?: (identityUrl: string) => { title: string } | null;
  onOpenAttachedStory?: (identityUrl: string) => void;
}

function isLogoOrFaviconUrl(url: string): boolean {
  return (
    url.includes("logo.clearbit.com") ||
    url.includes("gstatic.com/faviconV2") ||
    url.includes("/favicon") ||
    url.includes("/apple-touch-icon") ||
    url.includes("/site-icon") ||
    /\/icons?\//i.test(url)
  );
}

function formatTimestamp(date: Date): string {
  const postDate = new Date(date);
  const now = new Date();
  const tz = 'America/New_York';
  
  const postET = new Date(postDate.toLocaleString('en-US', { timeZone: tz }));
  const nowET = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  
  const isToday = postET.getDate() === nowET.getDate() &&
                  postET.getMonth() === nowET.getMonth() &&
                  postET.getFullYear() === nowET.getFullYear();
  
  if (isToday) {
    return postDate.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true,
      timeZone: tz
    });
  }
  
  const diffMs = now.getTime() - postDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays < 7) {
    return postDate.toLocaleString('en-US', { 
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: tz
    });
  }
  
  return postDate.toLocaleString('en-US', { 
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: tz
  });
}

function PostVideo({ videoUrl, thumbnailUrl, truthSocialUrl, postId }: { videoUrl: string; thumbnailUrl?: string | null; truthSocialUrl: string; postId: string }) {
  const [videoFailed, setVideoFailed] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);

  if (videoFailed) {
    if (thumbnailUrl && !thumbFailed) {
      return (
        <div
          className="mt-1.5 relative cursor-pointer group"
          onClick={(e) => {
            e.stopPropagation();
            window.open(truthSocialUrl, '_blank');
          }}
          data-testid={`video-thumbnail-${postId}`}
        >
          <img
            src={thumbnailUrl}
            alt="Video thumbnail"
            className="rounded-md w-full max-h-80 object-contain bg-black/5 dark:bg-white/5"
            onError={() => setThumbFailed(true)}
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-12 h-12 rounded-full bg-black/60 flex items-center justify-center">
              <Play className="w-6 h-6 text-white fill-white ml-0.5" />
            </div>
          </div>
          <div className="absolute bottom-2 left-2 bg-black/70 text-white text-[10px] px-2 py-0.5 rounded">
            Watch on Truth Social
          </div>
        </div>
      );
    }
    return (
      <div
        className="mt-1.5 rounded-md bg-muted/50 p-3 flex items-center gap-2 cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          window.open(truthSocialUrl, '_blank');
        }}
        data-testid={`video-link-${postId}`}
      >
        <Play className="w-4 h-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Video - tap to watch on Truth Social</span>
      </div>
    );
  }

  return (
    <div className="mt-1.5" data-testid={`video-container-${postId}`}>
      <video
        src={videoUrl}
        controls
        preload="metadata"
        poster={thumbnailUrl || undefined}
        className="rounded-md w-full max-h-80 bg-black/5 dark:bg-white/5"
        onError={() => setVideoFailed(true)}
        onClick={(e) => e.stopPropagation()}
        data-testid={`video-truth-social-${postId}`}
      />
    </div>
  );
}

function PostImage({
  url,
  postId,
  filterJunkImages,
}: {
  url: string;
  postId: string;
  filterJunkImages?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [tooSmall, setTooSmall] = useState(false);

  if (failed || tooSmall) {
    return null;
  }

  if (filterJunkImages && isLogoOrFaviconUrl(url)) {
    return null;
  }

  return (
    <div className="mt-1.5" data-testid={`img-container-${postId}`}>
      <img
        src={url}
        alt="Post attachment"
        className="rounded-md w-full max-h-80 object-contain bg-black/5 dark:bg-white/5"
        loading="lazy"
        onLoad={(e) => {
          if (!filterJunkImages) return;
          const img = e.target as HTMLImageElement;
          if (
            img.naturalWidth < 200 ||
            img.naturalHeight < 120 ||
            img.naturalWidth / img.naturalHeight > 5
          ) {
            setTooSmall(true);
          }
        }}
        onError={() => setFailed(true)}
        data-testid={`img-truth-social-${postId}`}
      />
    </div>
  );
}

function ExtractedTextBlock({ text, postId }: { text: string; postId: string }) {
  return (
    <div 
      className="mt-1 border-l-2 border-[#5FA8C4]/50 pl-2"
      data-testid={`text-extracted-image-${postId}`}
    >
      <div className="flex items-center gap-1 mb-0">
        <span className="text-[9px] font-medium text-[#5FA8C4] uppercase tracking-wider">
          Image Text
        </span>
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground italic whitespace-pre-line">
        {text}
      </p>
    </div>
  );
}

export default function TruthSocialFeed({ posts, filterJunkImages, variant = "default", scale, canAttachSocialPosts = false, findAttachedStory, onOpenAttachedStory }: TruthSocialFeedProps) {
  const tz = useTimezone();
  const s = variant === "curated" && scale ? CURATED_FEED_SCALE[scale] : null;
  const avatarCls = s?.avatar ?? "w-8 h-8";
  const authorCls = s?.author ?? "text-[11px]";
  const metaCls = s?.meta ?? "text-[10px]";
  const contentCls = s?.content ?? "text-[11px]";
  if (posts.length === 0) {
    return (
      <Card className="p-4">
        <div className="text-center text-sm text-muted-foreground">
          No Truth Social posts available yet
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {posts.map((post) => {
        const card = (
        <Card 
          key={post.id} 
          className={`p-3 hover-elevate active-elevate-2 cursor-pointer${variant === "curated" ? " shadow-md shadow-black/30 curated-feed-card" : ""}`}
          onClick={() => window.open(post.truthSocialUrl, '_blank')}
          data-testid={`card-truth-social-post-${post.id}`}
        >
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              {variant === "curated" ? (
                <div className="flex items-center gap-2">
                  <OutletLogo
                    outlet={{
                      canonicalName: POTUS_TRUTH_SOCIAL_CANONICAL_NAME,
                      logoSlug: POTUS_TRUTH_SOCIAL_LOGO_SLUG,
                      logoObjectFit: "contain",
                    }}
                    source={POTUS_TRUTH_SOCIAL_CANONICAL_NAME}
                    imageAlt="Seal of the President of the United States"
                    fallbackText="DJT"
                    sizeClass={avatarCls}
                    shapeClass="rounded-full"
                    className="flex-shrink-0 bg-white"
                  />
                  <div>
                    <div className={`${authorCls} font-semibold`} data-testid="text-author">
                      Donald J. Trump
                    </div>
                    <div className={`${metaCls} text-muted-foreground`} data-testid="text-timestamp">
                      {formatCuratedPostTime(post.postedAt, tz)}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <OutletLogo
                    outlet={{
                      canonicalName: POTUS_TRUTH_SOCIAL_CANONICAL_NAME,
                      logoSlug: POTUS_TRUTH_SOCIAL_LOGO_SLUG,
                      logoObjectFit: "contain",
                    }}
                    source={POTUS_TRUTH_SOCIAL_CANONICAL_NAME}
                    imageAlt="Seal of the President of the United States"
                    fallbackText="DJT"
                    sizeClass="w-8 h-8"
                    shapeClass="rounded-full"
                    className="flex-shrink-0 bg-white"
                  />
                  <div>
                    <div className="text-xs font-semibold" data-testid="text-author">
                      Donald J. Trump
                    </div>
                    <div className="text-xs text-muted-foreground font-mono" data-testid="text-timestamp">
                      {formatTimestamp(post.postedAt)}
                    </div>
                  </div>
                </div>
              )}
              {variant === "curated" ? (
                <div className="flex items-center gap-0.5 flex-shrink-0">
                  <CuratedSocialCardAction
                    editor={canAttachSocialPosts}
                    identityUrl={post.truthSocialUrl}
                    attachedStoryTitle={findAttachedStory?.(post.truthSocialUrl)?.title}
                    onOpenAttachedStory={() => onOpenAttachedStory?.(post.truthSocialUrl)}
                    copyTestId={`button-copy-truth-${post.id}`}
                    copyLabel="Copy post to clipboard"
                    buildHtml={() => buildTruthCopyHtml(post, tz)}
                  />
                </div>
              ) : (
                <ExternalLink className="h-3 w-3 text-muted-foreground flex-shrink-0" />
              )}
            </div>
            
            {(() => {
              const cleaned = cleanTruthContent(post.content);
              if (!cleaned || cleaned === '[Media attachment]') return null;
              return (
                <p className={`whitespace-pre-wrap ${variant === "curated" ? `leading-snug ${contentCls}` : "leading-relaxed text-base"}`} data-testid="text-content">
                  {variant === "curated" ? cleaned.replace(/\n{3,}/g, "\n\n") : cleaned}
                </p>
              );
            })()}

            {post.videoUrl && (
              <PostVideo
                videoUrl={post.videoUrl}
                thumbnailUrl={post.videoThumbnailUrl}
                truthSocialUrl={post.truthSocialUrl}
                postId={post.id}
              />
            )}

            {post.imageUrl && !post.videoUrl && (
              <PostImage
                url={post.imageUrl}
                postId={post.id}
                filterJunkImages={filterJunkImages}
              />
            )}

            {post.extractedImageText && (
              <ExtractedTextBlock text={post.extractedImageText} postId={post.id} />
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
                @realDonaldTrump
              </TooltipContent>
            </Tooltip>
          );
        }
        return card;
      })}
    </div>
  );
}
