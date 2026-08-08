import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Search, BookOpen, ChevronLeft, ChevronRight, Loader2, Database, Quote, ExternalLink } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface ArticleQuote {
  id: string;
  quoteText: string;
  speakerName: string;
  normalizedSpeaker: string;
  location: string | null;
  speakerTitle: string | null;
  event: string | null;
  subjectTags: string[];
  context: string;
  sourceUrl: string;
  dateSpoken: string | null;
  storyId: string;
  createdAt: string;
}

interface QuoteSearchResult {
  quotes: ArticleQuote[];
  total: number;
}

interface StoryData {
  id: string;
  headline: string;
  fullText: string | null;
  publishedAt: string | null;
  sourceUrl: string;
  sourceName: string | null;
}

interface QuoteStats {
  totalQuotes: number;
  storiesProcessed: number;
  storiesRemaining: number;
}

interface QuoteDatabaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function QuoteDatabaseDialog({ open, onOpenChange }: QuoteDatabaseDialogProps) {
  const [searchSpeaker, setSearchSpeaker] = useState("");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [searchTag, setSearchTag] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(0);
  const [activeSearch, setActiveSearch] = useState<{ speaker?: string; keyword?: string; tag?: string; fromDate?: string; toDate?: string } | null>(null);
  const [storyModalOpen, setStoryModalOpen] = useState(false);
  const [selectedStoryId, setSelectedStoryId] = useState<string | null>(null);
  const pageSize = 25;

  const statsQuery = useQuery<QuoteStats>({
    queryKey: ["/api/quotes/stats"],
    enabled: open,
    refetchInterval: 30000,
  });

  const searchQuery = useQuery<QuoteSearchResult>({
    queryKey: ["/api/quotes/search", activeSearch, page],
    queryFn: async () => {
      if (!activeSearch) return { quotes: [], total: 0 };
      const params = new URLSearchParams();
      if (activeSearch.speaker) params.set("speaker", activeSearch.speaker);
      if (activeSearch.keyword) params.set("keyword", activeSearch.keyword);
      if (activeSearch.tag) params.set("tag", activeSearch.tag);
      if (activeSearch.fromDate) params.set("fromDate", activeSearch.fromDate);
      if (activeSearch.toDate) params.set("toDate", activeSearch.toDate);
      params.set("limit", String(pageSize));
      params.set("offset", String(page * pageSize));
      const res = await fetch(`/api/quotes/search?${params.toString()}`);
      if (!res.ok) throw new Error("Search failed");
      return res.json();
    },
    enabled: open && activeSearch !== null,
  });

  const storyQuery = useQuery<StoryData>({
    queryKey: ["/api/stories", selectedStoryId],
    queryFn: async () => {
      const res = await fetch(`/api/stories/${selectedStoryId}`);
      if (!res.ok) throw new Error("Failed to fetch story");
      return res.json();
    },
    enabled: storyModalOpen && !!selectedStoryId,
  });

  const batchMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/quotes/batch-process");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/quotes/stats"] });
      if (activeSearch) {
        queryClient.invalidateQueries({ queryKey: ["/api/quotes/search"] });
      }
    },
  });

  const handleSearch = () => {
    const params: any = {};
    if (searchSpeaker.trim()) params.speaker = searchSpeaker.trim();
    if (searchKeyword.trim()) params.keyword = searchKeyword.trim();
    if (searchTag.trim()) params.tag = searchTag.trim();
    if (fromDate) params.fromDate = fromDate;
    if (toDate) params.toDate = toDate;
    if (Object.keys(params).length === 0) params.keyword = "";
    setPage(0);
    setActiveSearch(params);
  };

  const handleViewStory = (storyId: string) => {
    setSelectedStoryId(storyId);
    setStoryModalOpen(true);
  };

  const totalPages = Math.ceil((searchQuery.data?.total || 0) / pageSize);
  const stats = statsQuery.data;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[900px] max-h-[90vh] flex flex-col" data-testid="quote-database-dialog">
          <DialogHeader className="pb-3 border-b flex-shrink-0">
            <DialogTitle className="flex items-center gap-2" data-testid="quote-database-title">
              <Database className="w-5 h-5" />
              Quote Database
            </DialogTitle>
            {stats && (
              <div className="flex items-center gap-4 text-sm text-muted-foreground mt-1 flex-wrap">
                <span data-testid="text-total-quotes">{stats.totalQuotes.toLocaleString()} quotes extracted</span>
                <span data-testid="text-stories-processed">{stats.storiesProcessed.toLocaleString()} stories processed</span>
                <span data-testid="text-stories-remaining">{stats.storiesRemaining.toLocaleString()} stories remaining</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => batchMutation.mutate()}
                  disabled={batchMutation.isPending || stats.storiesRemaining === 0}
                  data-testid="button-batch-process"
                >
                  {batchMutation.isPending ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin mr-1" />
                      Processing...
                    </>
                  ) : (
                    "Process Backlog"
                  )}
                </Button>
              </div>
            )}
          </DialogHeader>

          <div className="flex-shrink-0 space-y-2 pt-3">
            <div className="flex gap-2 flex-wrap">
              <Input
                placeholder="Speaker name..."
                value={searchSpeaker}
                onChange={(e) => setSearchSpeaker(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                className="flex-1 min-w-[150px]"
                data-testid="input-search-speaker"
              />
              <Input
                placeholder="Keyword..."
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                className="flex-1 min-w-[150px]"
                data-testid="input-search-keyword"
              />
              <Input
                placeholder="Subject tag..."
                value={searchTag}
                onChange={(e) => setSearchTag(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                className="flex-1 min-w-[120px]"
                data-testid="input-search-tag"
              />
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              <Input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="w-[160px]"
                data-testid="input-from-date"
              />
              <span className="text-sm text-muted-foreground">to</span>
              <Input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="w-[160px]"
                data-testid="input-to-date"
              />
              <Button onClick={handleSearch} data-testid="button-search-quotes">
                <Search className="w-4 h-4 mr-1" />
                Search
              </Button>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto mt-3">
            {searchQuery.isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin mr-2" />
                <span className="text-muted-foreground">Searching...</span>
              </div>
            ) : !activeSearch ? (
              <div className="text-center py-16 text-muted-foreground" data-testid="text-search-prompt">
                <Quote className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="text-base">Search the quote database</p>
                <p className="text-sm mt-1">Enter a speaker name, keyword, or subject tag to find quotes</p>
              </div>
            ) : searchQuery.data && searchQuery.data.quotes.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground" data-testid="text-no-results">
                <p>No quotes found matching your search criteria.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {searchQuery.data?.quotes.map((quote) => (
                  <Card key={quote.id} className="p-4" data-testid={`card-quote-${quote.id}`}>
                    <div className="space-y-2">
                      <p className="text-base italic leading-relaxed" data-testid={`text-quote-${quote.id}`}>
                        "{quote.quoteText}"
                      </p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm" data-testid={`text-speaker-${quote.id}`}>
                          — {quote.normalizedSpeaker}{quote.speakerTitle ? `, ${quote.speakerTitle}` : ''}
                        </span>
                        {quote.speakerName !== quote.normalizedSpeaker && (
                          <span className="text-xs text-muted-foreground">(as "{quote.speakerName}")</span>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground" data-testid={`text-context-${quote.id}`}>
                        {[
                          quote.event && quote.location ? `At ${quote.event} in ${quote.location}` :
                          quote.event ? `At ${quote.event}` :
                          quote.location ? `At ${quote.location}` : null,
                          quote.context
                        ].filter(Boolean).join(', ')}
                      </p>
                      <div className="flex items-center gap-2 flex-wrap">
                        {quote.subjectTags.map((tag, i) => (
                          <Badge key={i} variant="secondary" className="text-xs" data-testid={`badge-tag-${quote.id}-${i}`}>
                            {tag}
                          </Badge>
                        ))}
                        {quote.dateSpoken && (
                          <span className="text-xs text-muted-foreground">
                            {new Date(quote.dateSpoken).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            })}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleViewStory(quote.storyId)}
                          data-testid={`button-view-story-${quote.id}`}
                        >
                          <BookOpen className="w-3 h-3 mr-1" />
                          View Archived Story
                        </Button>
                        <a
                          href={quote.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                          data-testid={`link-source-${quote.id}`}
                        >
                          <ExternalLink className="w-3 h-3" />
                          Original Source
                        </a>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-3 border-t flex-shrink-0">
              <span className="text-sm text-muted-foreground" data-testid="text-results-count">
                {searchQuery.data?.total.toLocaleString()} results
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  data-testid="button-prev-page"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="text-sm" data-testid="text-page-info">
                  Page {page + 1} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page >= totalPages - 1}
                  data-testid="button-next-page"
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={storyModalOpen} onOpenChange={setStoryModalOpen}>
        <DialogContent className="sm:max-w-[700px] max-h-[85vh] flex flex-col" data-testid="story-modal">
          <DialogHeader className="pb-3 border-b flex-shrink-0">
            <DialogTitle className="text-base leading-snug" data-testid="story-modal-title">
              {storyQuery.isLoading ? "Loading..." : storyQuery.data?.headline || "Archived Story"}
            </DialogTitle>
            {storyQuery.data && (
              <div className="flex items-center gap-3 text-sm text-muted-foreground mt-1 flex-wrap">
                {storyQuery.data.sourceName && <span>{storyQuery.data.sourceName}</span>}
                {storyQuery.data.publishedAt && (
                  <span>
                    {new Date(storyQuery.data.publishedAt).toLocaleDateString("en-US", {
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                )}
                <a
                  href={storyQuery.data.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
                  data-testid="link-story-source"
                >
                  <ExternalLink className="w-3 h-3" />
                  Original
                </a>
              </div>
            )}
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto py-4">
            {storyQuery.isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>
            ) : storyQuery.data?.fullText ? (
              <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap text-sm leading-relaxed" data-testid="text-story-content">
                {storyQuery.data.fullText}
              </div>
            ) : (
              <p className="text-center text-muted-foreground py-8" data-testid="text-no-story">
                Full article text is not available for this story.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
