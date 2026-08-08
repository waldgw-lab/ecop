import HeadlineCard, { type HeadlineCardProps } from "./HeadlineCard";

interface HeadlineFeedProps {
  headlines: HeadlineCardProps[];
  groupByTime?: boolean;
}

export default function HeadlineFeed({ headlines, groupByTime = true }: HeadlineFeedProps) {
  if (headlines.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-3">
          <span className="text-2xl" data-testid="icon-empty-state">📰</span>
        </div>
        <h3 className="text-sm font-semibold mb-1" data-testid="text-no-results-title">
          No headlines match your filters
        </h3>
        <p className="text-xs text-muted-foreground" data-testid="text-no-results-description">
          Try adjusting your filters or search query
        </p>
      </div>
    );
  }

  if (!groupByTime) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {headlines.map((headline) => (
          <HeadlineCard key={headline.id} {...headline} />
        ))}
      </div>
    );
  }

  // Group headlines by time period based on actual publication dates
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
  
  // Helper to check if a headline is manually submitted
  const isManual = (h: HeadlineCardProps) => h.source?.includes('(Manual)') ?? false;
  
  // Filter headlines for "Earlier Today" group
  const earlierCandidates = headlines.filter(h => {
    if (!h.publishedDate) return false;
    const date = new Date(h.publishedDate);
    return date < oneHourAgo && date >= startOfToday;
  });
  
  // Sort "Earlier Today": Manual submissions first, then by priority score
  // Cap at 24 stories maximum
  const earlierSorted = earlierCandidates.sort((a, b) => {
    const aIsManual = isManual(a);
    const bIsManual = isManual(b);
    
    // Manual submissions always come first
    if (aIsManual && !bIsManual) return -1;
    if (!aIsManual && bIsManual) return 1;
    
    // For non-manual or both manual, sort by priority score (higher priority first)
    const aPriority = a.priorityScore ?? 0;
    const bPriority = b.priorityScore ?? 0;
    return bPriority - aPriority;
  }).slice(0, 24); // Cap at 24 stories
  
  const groups = {
    recent: headlines.filter(h => {
      if (!h.publishedDate) return false;
      const date = new Date(h.publishedDate);
      return date >= oneHourAgo;
    }),
    earlier: earlierSorted,
    yesterday: headlines.filter(h => {
      if (!h.publishedDate) return false;
      const date = new Date(h.publishedDate);
      return date < startOfToday;
    }),
  };

  return (
    <div className="space-y-3">
      {groups.recent.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2" data-testid="text-group-recent">
            Last Hour
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {groups.recent.map((headline) => (
              <HeadlineCard key={headline.id} {...headline} />
            ))}
          </div>
        </div>
      )}
      
      {groups.earlier.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider" data-testid="text-group-earlier">
              Earlier Today
            </h2>
            {earlierCandidates.length > 24 && (
              <span className="text-xs text-muted-foreground">
                Showing top 24 of {earlierCandidates.length}
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {groups.earlier.map((headline) => (
              <HeadlineCard key={headline.id} {...headline} />
            ))}
          </div>
        </div>
      )}
      
      {groups.yesterday.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2" data-testid="text-group-yesterday">
            Yesterday
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {groups.yesterday.map((headline) => (
              <HeadlineCard key={headline.id} {...headline} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
