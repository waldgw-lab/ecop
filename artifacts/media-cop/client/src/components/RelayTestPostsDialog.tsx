import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RefreshCw, ExternalLink, Image, Video, Repeat2, Code, ChevronDown, ChevronRight } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import { format } from "date-fns";

interface RelayPost {
  id: string;
  postId: string;
  content: string;
  postedAt: string;
  truthSocialUrl: string;
  imageUrl: string | null;
  videoUrl: string | null;
  videoThumbnailUrl: string | null;
  isReblog: boolean;
  rebloggedFrom: string | null;
  rawPayload: string | null;
  receivedAt: string;
}

interface RelayTestPostsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RelayTestPostsDialog({ open, onOpenChange }: RelayTestPostsDialogProps) {
  const [expandedPayloads, setExpandedPayloads] = useState<Set<string>>(new Set());

  const togglePayload = (id: string) => {
    setExpandedPayloads(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const { data: posts = [], isLoading, isRefetching } = useQuery<RelayPost[]>({
    queryKey: ["/api/team/relay-test-posts"],
    enabled: open,
    refetchInterval: open ? 15000 : false,
  });

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/team/relay-test-posts"] });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <DialogTitle className="flex items-center gap-2">
              Truth Social Relay Monitor
              <Badge variant="outline" className="ml-1">
                Staging
              </Badge>
            </DialogTitle>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {posts.length} post{posts.length !== 1 ? "s" : ""} received
              </span>
              <Button
                size="icon"
                variant="ghost"
                onClick={handleRefresh}
                disabled={isRefetching}
                data-testid="button-refresh-relay"
              >
                <RefreshCw className={`w-4 h-4 ${isRefetching ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Posts received from the Google VM relay. Auto-refreshes every 15 seconds.
          </p>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : posts.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              No relay posts received yet. Send a test from your Google VM to see data here.
            </div>
          ) : (
            <div className="space-y-3 pr-3">
              {posts.map((post) => (
                <div
                  key={post.id}
                  className="border rounded-md p-3 space-y-2"
                  data-testid={`relay-post-${post.postId}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="secondary" className="text-xs font-mono">
                        {post.postId}
                      </Badge>
                      {post.isReblog && (
                        <Badge variant="outline" className="text-xs">
                          <Repeat2 className="w-3 h-3 mr-1" />
                          {post.rebloggedFrom || "Reblog"}
                        </Badge>
                      )}
                      {post.imageUrl && (
                        <Badge variant="outline" className="text-xs">
                          <Image className="w-3 h-3 mr-1" />
                          Image
                        </Badge>
                      )}
                      {post.videoUrl && (
                        <Badge variant="outline" className="text-xs">
                          <Video className="w-3 h-3 mr-1" />
                          Video
                        </Badge>
                      )}
                    </div>
                    {post.truthSocialUrl && (
                      <a
                        href={post.truthSocialUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground shrink-0"
                        data-testid={`link-relay-post-${post.postId}`}
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    )}
                  </div>

                  <p className="text-sm whitespace-pre-wrap break-words" data-testid={`text-relay-content-${post.postId}`}>
                    {post.content}
                  </p>

                  {post.imageUrl && (
                    <img
                      src={post.imageUrl}
                      alt="Post image"
                      className="max-h-48 rounded-md object-cover"
                      data-testid={`img-relay-${post.postId}`}
                    />
                  )}

                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>
                      Posted: {format(new Date(post.postedAt), "MMM d, yyyy h:mm a")}
                    </span>
                    <span>
                      Received: {format(new Date(post.receivedAt), "MMM d, yyyy h:mm:ss a")}
                    </span>
                  </div>

                  {post.rawPayload && (
                    <div>
                      <button
                        onClick={() => togglePayload(post.id)}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        data-testid={`button-raw-json-${post.postId}`}
                      >
                        <Code className="w-3 h-3" />
                        {expandedPayloads.has(post.id) ? (
                          <ChevronDown className="w-3 h-3" />
                        ) : (
                          <ChevronRight className="w-3 h-3" />
                        )}
                        Raw JSON
                      </button>
                      {expandedPayloads.has(post.id) && (
                        <pre
                          className="mt-1 p-2 bg-muted rounded-md text-xs overflow-x-auto max-h-48 whitespace-pre-wrap break-all font-mono"
                          data-testid={`text-raw-json-${post.postId}`}
                        >
                          {(() => {
                            try { return JSON.stringify(JSON.parse(post.rawPayload!), null, 2); }
                            catch { return post.rawPayload; }
                          })()}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
