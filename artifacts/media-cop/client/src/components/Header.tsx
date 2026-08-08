import { useState } from "react";
import { Search, Download, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import ThemeToggle from "./ThemeToggle";
import ViewSwitcher from "./ViewSwitcher";
import { useQuery } from "@tanstack/react-query";
import { useTheme } from "@/components/ThemeProvider";
import mcopBotIcon from "@assets/generated_images/mcop_bot_robot_mascot_icon.png";
import mcopLogoWhite from "@assets/Logo5_WHITE_1782606805634.png";
import mcopLogoBlack from "@assets/Logo5_BLACK_1782606794585.png";

interface HeaderProps {
  autoRefresh: boolean;
  onAutoRefreshChange: (enabled: boolean) => void;
  onManualRefresh: () => void;
  isRefreshing: boolean;
  onMcopBotClick?: () => void;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  onSearchSubmit?: () => void;
}

function formatCaoDate(caoDate: string) {
  const d = new Date(caoDate);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const dd = String(d.getDate()).padStart(2, '0');
  const mon = months[d.getMonth()];
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${dd}${mon}${yyyy} ${hh}:${mm}`;
}

export default function Header({
  autoRefresh,
  onAutoRefreshChange,
  onManualRefresh,
  isRefreshing,
  onMcopBotClick,
  searchQuery,
  onSearchChange,
  onSearchSubmit,
}: HeaderProps) {
  const [scrubViewerOpen, setScrubViewerOpen] = useState(false);
  const { theme } = useTheme();
  const { data: curatedAccess } = useQuery<{ hasCuratedAccess: boolean }>({
    queryKey: ['/api/auth/curated-access'],
    retry: false,
  });
  const { data: latestScrub } = useQuery<{ id: string; caoDate: string; filename: string; hasHtml: boolean }>({
    queryKey: ['/api/daily-news-scrub/latest'],
    refetchInterval: 60000,
    retry: false,
  });

  const { data: scrubHtmlData, isLoading: scrubHtmlLoading } = useQuery<{ htmlContent: string }>({
    queryKey: ['/api/daily-news-scrub', latestScrub?.id, 'html'],
    queryFn: async () => {
      const res = await fetch(`/api/daily-news-scrub/${latestScrub!.id}/html`, { credentials: 'include' });
      if (!res.ok) throw new Error('No HTML available');
      return res.json();
    },
    enabled: scrubViewerOpen && !!latestScrub?.id && !!latestScrub?.hasHtml,
    retry: false,
  });

  return (
    <>
    <header className="border-b bg-card sticky top-0 z-50">
      <div className="w-full px-6 py-2">
        <div className="flex items-center justify-between flex-wrap gap-x-2 gap-y-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <div className="flex flex-col items-start shrink-0">
              <img
                src={theme === "dark" ? mcopLogoWhite : mcopLogoBlack}
                alt="MOOP"
                className="h-24 w-auto"
                data-testid="icon-logo"
              />
              <p className="text-[10px] text-muted-foreground leading-tight" style={{ marginLeft: '5px' }} data-testid="text-app-subtitle">
                Classic View
              </p>
            </div>

            {onMcopBotClick && (
              <button
                onClick={onMcopBotClick}
                className="ml-1 flex items-center gap-1.5 hover-elevate rounded-full px-2 py-1 transition-colors shrink-0"
                data-testid="button-mcopBot"
              >
                <img
                  src={mcopBotIcon}
                  alt="MCOP Bot"
                  className="w-7 h-7 object-cover rounded-full"
                />
                <span className="text-xs font-medium text-primary">Ask MCOP Bot</span>
              </button>
            )}

            {onSearchChange && onSearchSubmit && (
              <div className="flex gap-1.5">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Search headlines..."
                    value={searchQuery || ''}
                    onChange={(e) => onSearchChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && searchQuery?.trim()) {
                        e.preventDefault();
                        onSearchSubmit();
                      }
                    }}
                    className="pl-8 w-28 h-8 text-xs"
                    data-testid="input-header-search"
                  />
                </div>
                <Button
                  size="icon"
                  variant="outline"
                  className="h-8 w-8"
                  onClick={() => searchQuery?.trim() && onSearchSubmit()}
                  disabled={!searchQuery?.trim()}
                  data-testid="button-header-search"
                >
                  <Search className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            {latestScrub && (
              <Button
                variant="default"
                size="sm"
                data-testid="button-download-scrub"
                onClick={() => setScrubViewerOpen(true)}
              >
                <FileText className="w-4 h-4 mr-1.5" />
                News Scrub · CAO {formatCaoDate(latestScrub.caoDate)}
              </Button>
            )}

            <div className="flex items-center gap-1.5">
              <Switch
                id="auto-refresh"
                checked={autoRefresh}
                onCheckedChange={(checked) => {
                  onAutoRefreshChange(checked);
                  console.log('Auto-refresh toggled:', checked);
                }}
                data-testid="switch-auto-refresh"
              />
              <label htmlFor="auto-refresh" className="text-sm font-medium cursor-pointer" data-testid="label-auto-refresh">
                Auto-refresh
              </label>
              <Button
                size="sm"
                onClick={() => {
                  onManualRefresh();
                  console.log('Manual refresh triggered');
                }}
                disabled={isRefreshing}
                data-testid="button-refresh"
              >
                {isRefreshing ? 'Refreshing...' : 'Refresh Now'}
              </Button>
            </div>

            <ThemeToggle />

            <ViewSwitcher
              current="classic"
              hasCuratedAccess={!!curatedAccess?.hasCuratedAccess}
              testIds={{ visual: "button-view-toggle" }}
            />
          </div>
        </div>
      </div>
    </header>

    {latestScrub && (
      <Dialog open={scrubViewerOpen} onOpenChange={setScrubViewerOpen}>
        <DialogContent className="max-w-5xl w-[95vw] h-[90vh] flex flex-col p-0 overflow-visible" onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader className="flex flex-row items-center justify-between px-6 py-4 border-b shrink-0">
            <div className="flex items-center gap-3">
              <FileText className="w-6 h-6 text-primary" />
              <div>
                <DialogTitle className="text-lg font-semibold" data-testid="scrub-viewer-title">
                  Current News Scrub
                </DialogTitle>
                <p className="text-sm text-muted-foreground">
                  CAO {formatCaoDate(latestScrub.caoDate)} — {latestScrub.filename}
                </p>
              </div>
            </div>
            <a href={`/api/daily-news-scrub/${latestScrub.id}/download`} download>
              <Button variant="default" data-testid="button-scrub-viewer-download">
                <Download className="w-4 h-4 mr-2" />
                Download PDF
              </Button>
            </a>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {latestScrub.hasHtml && scrubHtmlData?.htmlContent ? (
              <div
                className="news-scrub-viewer px-8 py-6 max-w-4xl mx-auto"
                dangerouslySetInnerHTML={{ __html: scrubHtmlData.htmlContent }}
                data-testid="scrub-viewer-html"
              />
            ) : latestScrub.hasHtml && scrubHtmlLoading ? (
              <div className="flex items-center justify-center h-full gap-3">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
                <span className="text-muted-foreground">Loading formatted content...</span>
              </div>
            ) : (
              <iframe
                src={`/api/daily-news-scrub/${latestScrub.id}/download?inline=true`}
                className="w-full h-full border-0"
                title="News Scrub PDF Viewer"
                data-testid="scrub-viewer-iframe"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    )}
    </>
  );
}
