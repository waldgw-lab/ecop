import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { SiX } from "react-icons/si";
import { formatDistanceToNow } from "date-fns";

interface XPost {
  id: string;
  content: string;
  postedAt: string;
  xUrl: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
  sourceAccount?: string;
  source: "x_posts" | "rapid" | "dow" | "sentdefender" | "osint" | "flight";
  isHidden: boolean;
}

const SOURCE_LABELS: Record<string, string> = {
  x_posts: "SecWar/Hegseth",
  sentdefender: "SentDefender",
  osint: "OSINT",
  rapid: "RapidResponse",
  dow: "DOWResponse",
  flight: "Flight Tracking",
};

const FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "x_posts", label: "SecWar/Hegseth" },
  { value: "sentdefender", label: "SentDefender" },
  { value: "osint", label: "OSINT" },
  { value: "rapid", label: "RapidResponse" },
  { value: "dow", label: "DOWResponse" },
  { value: "flight", label: "Flight Tracking" },
];

const INVALIDATE_KEYS = [
  ['/api/x-posts'],
  ['/api/sentdefender-posts'],
  ['/api/osint-posts'],
  ['/api/dowresponse-posts'],
  ['/api/rapidresponse-posts'],
  ['/api/flight-tracking/posts'],
  ['/api/x-feed/all'],
  ['/api/stream-data'],
];

export function ManageXPostsDialog() {
  const [open, setOpen] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("all");

  const { data: allPosts = [], isLoading } = useQuery<XPost[]>({
    queryKey: ['/api/x-feed/all'],
    enabled: open,
  });

  const hideMutation = useMutation({
    mutationFn: async ({ source, id, hidden }: { source: string; id: string; hidden: boolean }) => {
      await apiRequest('PATCH', `/api/x-feed/${source}/${id}/hide`, { hidden });
    },
    onSuccess: () => {
      INVALIDATE_KEYS.forEach((key) => {
        queryClient.invalidateQueries({ queryKey: key });
      });
    },
  });

  const filteredPosts = sourceFilter === "all"
    ? allPosts
    : allPosts.filter((p) => p.source === sourceFilter);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          data-testid="button-manage-x-posts"
        >
          <SiX className="w-4 h-4 mr-2" />
          Manage X Posts
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle data-testid="text-manage-x-posts-title">Manage X Posts</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="w-[180px]" data-testid="select-source-filter">
              <SelectValue placeholder="Filter by source" />
            </SelectTrigger>
            <SelectContent>
              {FILTER_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} data-testid={`select-source-${opt.value}`}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {filteredPosts.length} post{filteredPosts.length !== 1 ? "s" : ""}
          </span>
        </div>

        <ScrollArea className="flex-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : filteredPosts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8" data-testid="text-no-posts">No posts found.</p>
          ) : (
            <div className="space-y-2 pr-3">
              {filteredPosts.map((post) => (
                <div
                  key={`${post.source}-${post.id}`}
                  className={`flex items-start gap-3 p-3 rounded-md border ${post.isHidden ? 'opacity-50 bg-muted/30' : ''}`}
                  data-testid={`manage-xpost-${post.source}-${post.id}`}
                >
                  {post.imageUrl && (
                    <img
                      src={post.imageUrl}
                      alt=""
                      className="w-12 h-12 rounded-md object-cover flex-shrink-0"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      data-testid={`img-xpost-${post.source}-${post.id}`}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <Badge variant="outline" className="text-[10px]" data-testid={`badge-source-${post.source}-${post.id}`}>
                        {SOURCE_LABELS[post.source] || post.source}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground font-mono" data-testid={`text-xpost-time-${post.source}-${post.id}`}>
                        {formatDistanceToNow(new Date(post.postedAt), { addSuffix: true })}
                      </span>
                      {post.isHidden && (
                        <Badge variant="secondary" className="text-[10px]">Hidden</Badge>
                      )}
                      {post.videoUrl && (
                        <Badge variant="outline" className="text-[10px]">Video</Badge>
                      )}
                    </div>
                    <p className="text-xs leading-relaxed line-clamp-2" data-testid={`text-xpost-content-${post.source}-${post.id}`}>
                      {post.content && post.content.length > 100 ? post.content.slice(0, 100) + "..." : post.content}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant={post.isHidden ? 'default' : 'ghost'}
                    onClick={() => hideMutation.mutate({ source: post.source, id: post.id, hidden: !post.isHidden })}
                    disabled={hideMutation.isPending}
                    data-testid={`button-toggle-hide-${post.source}-${post.id}`}
                  >
                    {post.isHidden ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
