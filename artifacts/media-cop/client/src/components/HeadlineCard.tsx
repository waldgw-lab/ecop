import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";

export interface HeadlineCardProps {
  id: string;
  title: string;
  url: string;
  category: string;
  timestamp: string;
  source?: string;
  summary?: string;
  publishedDate?: Date; // Raw date for grouping
  tags?: string[];
  pdfPath?: string | null;
  priorityScore?: number; // For sorting by relevancy
}

export default function HeadlineCard({ id, title, url, category, timestamp, source, summary, tags, pdfPath }: HeadlineCardProps) {
  const handleClick = () => {
    // Prefer PDF over URL if both exist
    let targetUrl = pdfPath || url;
    
    // For PDF paths, just use the relative path - browser will use current domain
    // This avoids issues with Replit dev subdomains that don't have valid SSL certs
    if (pdfPath && pdfPath.startsWith('/objects/')) {
      window.open(pdfPath, '_blank');
      return;
    }
    
    // For external URLs, open directly
    window.open(targetUrl, '_blank');
  };

  return (
    <Card 
      className="p-3 border-l-4 border-l-primary hover-elevate active-elevate-2 transition-shadow cursor-pointer"
      data-testid={`card-headline-${id}`}
      onClick={handleClick}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground font-mono" data-testid={`text-timestamp-${id}`}>
            {timestamp}
          </span>
        </div>
        <ExternalLink className="h-3 w-3 text-muted-foreground flex-shrink-0" data-testid={`icon-external-${id}`} />
      </div>
      
      <h3 className="text-xs font-semibold leading-snug line-clamp-3 mb-2" data-testid={`text-title-${id}`}>
        {title}
      </h3>
      
      <div className="flex items-center gap-2">
        {source && (
          <span className="text-xs text-primary font-medium hover:underline" data-testid={`link-source-${id}`}>
            {source}
          </span>
        )}
      </div>
    </Card>
  );
}
