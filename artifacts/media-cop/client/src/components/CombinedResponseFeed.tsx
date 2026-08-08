import { Card } from "@/components/ui/card";
import { ExternalLink } from "lucide-react";
import type { RapidResponsePost, DOWResponsePost } from "@shared/schema";

interface CombinedResponseFeedProps {
  rapidResponsePosts: RapidResponsePost[];
  dowResponsePosts: DOWResponsePost[];
}

type CombinedPost = {
  id: string;
  postId: string;
  content: string;
  postedAt: Date;
  xUrl: string;
  source: 'rapidresponse' | 'dowresponse';
  sourceLabel: string;
  sourceInitials: string;
};

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

export default function CombinedResponseFeed({ rapidResponsePosts, dowResponsePosts }: CombinedResponseFeedProps) {
  // Combine and sort posts by timestamp
  const combinedPosts: CombinedPost[] = [
    ...rapidResponsePosts.map(post => ({
      id: post.id,
      postId: post.postId,
      content: post.content,
      postedAt: post.postedAt,
      xUrl: post.xUrl,
      source: 'rapidresponse' as const,
      sourceLabel: '@Rapidresponse47',
      sourceInitials: 'R47',
    })),
    ...dowResponsePosts.map(post => ({
      id: post.id,
      postId: post.postId,
      content: post.content,
      postedAt: post.postedAt,
      xUrl: post.xUrl,
      source: 'dowresponse' as const,
      sourceLabel: '@DOWResponse',
      sourceInitials: 'DR',
    })),
  ].sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime());

  if (combinedPosts.length === 0) {
    return (
      <div className="text-sm text-muted-foreground" data-testid="text-no-combined-posts">
        No posts available
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {combinedPosts.map((post) => (
        <Card 
          key={post.id} 
          className="p-3 hover-elevate active-elevate-2 cursor-pointer transition-all"
          data-testid={`card-combined-post-${post.postId}`}
          onClick={() => window.open(post.xUrl, '_blank')}
        >
          <div className="space-y-2">
            <div className="flex items-start gap-2">
              <div className="flex-shrink-0">
                <div className="h-8 w-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold">
                  {post.sourceInitials}
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold" data-testid={`text-combined-author-${post.source}`}>
                      {post.sourceLabel}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono" data-testid={`text-combined-timestamp-${post.postId}`}>
                      {formatTimestamp(post.postedAt)}
                    </div>
                  </div>
                  <ExternalLink className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                </div>
              </div>
            </div>
            
            <div className="text-sm leading-relaxed" data-testid={`text-combined-content-${post.postId}`}>
              {post.content}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
