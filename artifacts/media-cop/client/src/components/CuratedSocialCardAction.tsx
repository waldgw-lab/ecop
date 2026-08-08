import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronDown, Copy, Link2, Loader2 } from "lucide-react";
import CopyShareButton from "@/components/CopyShareButton";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { copyRichText } from "@/lib/richCopy";

type SocialLinkCandidate = {
  id: string;
  laneType: string;
  source: string;
  snippet: string;
  url: string;
  postedAt: string;
};

type AttachTarget = {
  id: string;
  clusterId: string | null;
  title: string;
  displayTitle?: string | null;
  headline?: string | null;
  url: string;
  sourceCount: number;
  articlePublishedAt?: string | null;
  scrapedAt: string;
};

function normalizeBrowserIdentityUrl(raw: string): string {
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

function targetTitle(target: AttachTarget): string {
  return target.headline || target.displayTitle || target.title || "Untitled story";
}

export default function CuratedSocialCardAction({
  editor,
  identityUrl,
  buildHtml,
  copyLabel = "Copy post to clipboard",
  copyTestId,
  attachedStoryTitle,
  onOpenAttachedStory,
}: {
  editor: boolean;
  identityUrl: string;
  buildHtml: () => string;
  copyLabel?: string;
  copyTestId: string;
  attachedStoryTitle?: string | null;
  onOpenAttachedStory?: () => void;
}) {
  const { toast } = useToast();
  const [pickerOpen, setPickerOpen] = useState(false);

  const candidatesQuery = useQuery<SocialLinkCandidate[]>({
    queryKey: ["/api/curated/social-link-candidates"],
    enabled: editor && pickerOpen,
    staleTime: 0,
  });
  const targetsQuery = useQuery<{ stories?: AttachTarget[] }>({
    queryKey: ["/api/curated/attach-targets"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/curated/top-stories?hours=24&limit=100");
      return response.json();
    },
    enabled: editor && pickerOpen,
    staleTime: 0,
  });

  const eligibleCandidate = useMemo(() => {
    const identity = normalizeBrowserIdentityUrl(identityUrl);
    return (candidatesQuery.data ?? []).find(
      (candidate) => normalizeBrowserIdentityUrl(candidate.url) === identity,
    );
  }, [candidatesQuery.data, identityUrl]);

  const targets = useMemo(
    () =>
      (targetsQuery.data?.stories ?? []).filter(
        (story) => !!story.clusterId && story.sourceCount >= 2,
      ),
    [targetsQuery.data],
  );

  const attach = useMutation({
    mutationFn: async (target: AttachTarget) => {
      if (!eligibleCandidate || !target.clusterId) {
        throw new Error("This post or story is no longer eligible for attachment.");
      }
      const response = await apiRequest("POST", "/api/curated/link-items", {
        memberUrls: [eligibleCandidate.url, target.url],
        kind: "link",
        label: targetTitle(target).slice(0, 200),
        fromSocialCard: true,
        socialUrl: eligibleCandidate.url,
        targetClusterId: target.clusterId,
      });
      return response.json() as Promise<{
        ok: boolean;
        reshaped?: boolean;
        formed?: boolean;
        deferred?: boolean;
      }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/curated/top-stories"] });
      queryClient.invalidateQueries({ queryKey: ["/api/curated/cluster-members"] });
      queryClient.invalidateQueries({ queryKey: ["/api/curated/attach-targets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/curated/social-link-candidates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/curated/manual-links"] });
      setPickerOpen(false);
      toast({
        title: result.deferred ? "Attached — grouping in progress" : "Post attached",
        description: result.deferred
          ? "The link is saved and will appear when the current Curated re-shape finishes."
          : "The social post was linked to the active story as attach-only coverage.",
      });
    },
    onError: (error) => {
      toast({
        title: "Failed to attach post",
        description: error instanceof Error ? error.message : "The post was not attached.",
        variant: "destructive",
      });
    },
  });

  if (!editor) {
    return (
      <CopyShareButton
        testId={copyTestId}
        label={copyLabel}
        buildHtml={buildHtml}
      />
    );
  }

  const loading =
    candidatesQuery.isLoading ||
    candidatesQuery.isFetching ||
    targetsQuery.isLoading ||
    targetsQuery.isFetching;
  const failed = candidatesQuery.isError || targetsQuery.isError;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Post actions"
            title="Post actions"
            data-testid={`button-social-actions-${copyTestId}`}
            className="inline-flex items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-32"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <DropdownMenuItem
            data-testid={`menu-copy-${copyTestId}`}
            onSelect={() => void copyRichText(buildHtml(), toast)}
          >
            <Copy className="h-3.5 w-3.5" />
            Copy
          </DropdownMenuItem>
          <DropdownMenuItem
            className={
              attachedStoryTitle
                ? "text-[#789BA9] focus:text-[#789BA9]"
                : "text-[#5FA8C4] focus:text-[#5FA8C4]"
            }
            data-testid={`menu-attach-${copyTestId}`}
            title={attachedStoryTitle ? `View attached story: ${attachedStoryTitle}` : undefined}
            onSelect={() => {
              if (attachedStoryTitle && onOpenAttachedStory) {
                onOpenAttachedStory();
                return;
              }
              setPickerOpen(true);
            }}
          >
            <Link2 className="h-3.5 w-3.5" />
            {attachedStoryTitle ? "Attached · View story" : "Attach"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={pickerOpen}
        onOpenChange={(open) => {
          setPickerOpen(open);
          if (open) {
            void candidatesQuery.refetch();
            void targetsQuery.refetch();
          }
        }}
      >
        <DialogContent
          className="max-w-md"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>Attach post to a story</DialogTitle>
            <DialogDescription>
              Choose an active formed story. The post joins as attach-only coverage and cannot
              promote or represent the story.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="py-6 text-sm text-muted-foreground">
              <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
              Refreshing approved post and active stories…
            </div>
          ) : failed ? (
            <div className="py-6 text-sm text-destructive">
              Could not refresh the attachment options. Close and try again.
            </div>
          ) : !eligibleCandidate ? (
            <div className="py-6 text-sm text-destructive" data-testid="social-attach-ineligible">
              This post is not currently approved and available in Curated, so it cannot be
              attached.
            </div>
          ) : targets.length === 0 ? (
            <div className="py-6 text-sm text-muted-foreground">
              No active formed stories are available to attach to.
            </div>
          ) : (
            <div className="max-h-[55vh] space-y-1 overflow-y-auto">
              {targets.map((target) => (
                <Button
                  key={target.clusterId}
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start whitespace-normal px-3 py-2 text-left"
                  disabled={attach.isPending}
                  data-testid={`button-social-attach-target-${target.clusterId}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    attach.mutate(target);
                  }}
                >
                  <span className="min-w-0">
                    <span className="block text-sm leading-snug">{targetTitle(target)}</span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {target.sourceCount} sources
                    </span>
                  </span>
                  {attach.isPending && (
                    <Loader2 className="ml-auto h-4 w-4 shrink-0 animate-spin" />
                  )}
                </Button>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}