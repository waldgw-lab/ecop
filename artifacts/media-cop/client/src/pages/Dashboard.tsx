import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Filter, Loader2, Send, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import Header from "@/components/Header";
import FilterBar from "@/components/FilterBar";
import HeadlineFeed from "@/components/HeadlineFeed";
import TopStories from "@/components/TopStories";
import TruthSocialFeed from "@/components/TruthSocialFeed";
import XPostsFeed from "@/components/XPostsFeed";
import CombinedResponseFeed from "@/components/CombinedResponseFeed";
import SentDefenderFeed from "@/components/SentDefenderFeed";
import FirstAlertFeed from "@/components/FirstAlertFeed";
import TopicFilterDialog from "@/components/TopicFilterDialog";
import MarketTicker from "@/components/MarketTicker";
import { MCOPBotDialog } from "@/components/MCOPBotDialog";
import CuratedNudge from "@/components/CuratedNudge";
import type { HeadlineCardProps } from "@/components/HeadlineCard";
import type { TopStoryProps } from "@/components/TopStories";
import type { Headline, TruthSocialPost, XPost, RapidResponsePost, DOWResponsePost, SentDefenderPost, OsintPost, ManualSubmission, FirstAlert } from "@shared/schema";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface TeamSubmission {
  id: string;
  headline: string;
  summary: string;
  url: string;
  sourceType: string;
  publishedAt: string | null;
  createdAt: string;
  isRead: boolean;
  priorityScore: number;
}

interface TeamSubject {
  id: string;
  name: string;
  submissions: TeamSubmission[];
}

interface SubjectsResponse {
  active: TeamSubject[];
  archived: TeamSubject[];
}

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export default function Dashboard() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  // MCOP Bot AI assistant state
  const [mcopBotOpen, setMcopBotOpen] = useState(false);
  
  // Header search state
  const [headerSearchQuery, setHeaderSearchQuery] = useState('');
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);
  
  // Column visibility state (default: all visible)
  const [showTopStories, setShowTopStories] = useState(() => {
    const saved = localStorage.getItem('showTopStories');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [showTruthSocial, setShowTruthSocial] = useState(() => {
    const saved = localStorage.getItem('showTruthSocial');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [showSecWar, setShowSecWar] = useState(() => {
    const saved = localStorage.getItem('showSecWar');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [showSentDefender, setShowSentDefender] = useState(() => {
    const saved = localStorage.getItem('showSentDefender');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [showResponseFeed, setShowResponseFeed] = useState(() => {
    const saved = localStorage.getItem('showResponseFeed');
    return saved !== null ? JSON.parse(saved) : false;
  });
  const [showTicker, setShowTicker] = useState(() => {
    const saved = localStorage.getItem('showTicker');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [showFirstAlert, setShowFirstAlert] = useState(() => {
    const saved = localStorage.getItem('showFirstAlert');
    return saved !== null ? JSON.parse(saved) : true;
  });
  // OSINT feed selection state for OSINT X column
  const ALL_OSINT_FEED_IDS = ['sentdefender', 'MATA_osint', 'CENTCOM', 'SOUTHCOM', 'flightTracking'];
  // For returning users, any newly added feed not in their saved list is auto-enabled
  const [selectedOsintFeeds, setSelectedOsintFeeds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('selectedOsintFeeds');
      if (saved === null) return [...ALL_OSINT_FEED_IDS];
      const savedArr = JSON.parse(saved) as string[];
      const savedSet = new Set(savedArr);
      const validIds = new Set(ALL_OSINT_FEED_IDS);
      const result = savedArr.filter(id => validIds.has(id));
      for (const id of ALL_OSINT_FEED_IDS) {
        if (!savedSet.has(id)) {
          result.push(id);
        }
      }
      return result;
    } catch {
      return [...ALL_OSINT_FEED_IDS];
    }
  });

  // Command list filter state for DataMinr First Alert
  const [listFilterOpen, setListFilterOpen] = useState(false);
  const [selectedAlertLists, setSelectedAlertLists] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('selectedAlertLists');
      return saved !== null ? JSON.parse(saved) : [];
    } catch (error) {
      console.error('Failed to parse selected alert lists from localStorage:', error);
      return [];
    }
  });

  // Persist column visibility preferences to localStorage
  useEffect(() => {
    localStorage.setItem('showTopStories', JSON.stringify(showTopStories));
  }, [showTopStories]);

  useEffect(() => {
    localStorage.setItem('showTruthSocial', JSON.stringify(showTruthSocial));
  }, [showTruthSocial]);

  useEffect(() => {
    localStorage.setItem('showSecWar', JSON.stringify(showSecWar));
  }, [showSecWar]);

  useEffect(() => {
    localStorage.setItem('showSentDefender', JSON.stringify(showSentDefender));
  }, [showSentDefender]);

  useEffect(() => {
    localStorage.setItem('showResponseFeed', JSON.stringify(showResponseFeed));
  }, [showResponseFeed]);

  useEffect(() => {
    localStorage.setItem('showFirstAlert', JSON.stringify(showFirstAlert));
  }, [showFirstAlert]);
  useEffect(() => {
    localStorage.setItem('showTicker', JSON.stringify(showTicker));
  }, [showTicker]);

  useEffect(() => {
    localStorage.setItem('selectedOsintFeeds', JSON.stringify(selectedOsintFeeds));
  }, [selectedOsintFeeds]);

  useEffect(() => {
    localStorage.setItem('selectedAlertLists', JSON.stringify(selectedAlertLists));
  }, [selectedAlertLists]);

  // Fetch headline feed for Top Stories (18-hour window)
  const { data: headlineFeed18h = [], isLoading: isLoading18h } = useQuery<Array<Headline & { pdfPath?: string | null }>>({
    queryKey: ['/api/headline-feed', { hours: 18 }],
  });

  // Fetch headline feed for All Headlines (48-hour window to include yesterday's content)
  const { data: headlineFeed48h = [], isLoading: isLoading48h } = useQuery<Array<Headline & { pdfPath?: string | null }>>({
    queryKey: ['/api/headline-feed', { hours: 48 }],
  });

  // Loading state combines both queries
  const isLoading = isLoading18h || isLoading48h;

  // Fetch Truth Social posts
  const { data: truthSocialPosts = [] } = useQuery<TruthSocialPost[]>({
    queryKey: ['/api/truth-social-posts'],
  });

  // Fetch X posts
  const { data: xPosts = [] } = useQuery<XPost[]>({
    queryKey: ['/api/x-posts'],
  });

  // Fetch RapidResponse posts
  const { data: rapidResponsePosts = [] } = useQuery<RapidResponsePost[]>({
    queryKey: ['/api/rapidresponse-posts'],
  });

  // Fetch DOWResponse posts
  const { data: dowResponsePosts = [] } = useQuery<DOWResponsePost[]>({
    queryKey: ['/api/dowresponse-posts'],
  });

  // Fetch SentDefender posts
  const { data: sentDefenderPosts = [] } = useQuery<SentDefenderPost[]>({
    queryKey: ['/api/sentdefender-posts'],
  });

  // Fetch OSINT posts (@MATA_osint)
  const { data: osintPosts = [] } = useQuery<OsintPost[]>({
    queryKey: ['/api/osint-posts'],
  });

  // Fetch flight tracking posts (manual uploads)
  const { data: flightTrackingPosts = [] } = useQuery<any[]>({
    queryKey: ['/api/flight-tracking/posts'],
  });

  // Fetch First Alerts
  const { data: firstAlerts = [] } = useQuery<FirstAlert[]>({
    queryKey: ['/api/first-alerts'],
  });

  // Public search for team submissions - only triggered when searching
  const { data: publicSearchData, isFetching: isSearching } = useQuery<{ 
    submissions: Array<{
      id: string;
      headline: string;
      summary: string;
      sourceUrl: string;
      sourceName: string | null;
      topicName: string;
      priorityScore: number | null;
      createdAt: string;
      publishedAt: string | null;
    }> 
  }>({
    queryKey: ['/api/public-search', { q: headerSearchQuery }],
    enabled: headerSearchQuery.trim().length >= 2,
  });

  // Predefined command list filter options with counts from actual data
  const availableAlertLists = useMemo(() => {
    // Predefined list of categories in specific order
    const predefinedLists = [
      "AFRICOM",
      "CENTCOM",
      "EUCOM",
      "INDOPACOM",
      "NORTHCOM",
      "SOUTHCOM",
      "Global Terrorism and Mass Violence",
      "Israel/Hamas",
      "China",
      "Five Eyes + NATO",
      "Russia/Ukraine",
      "US Politics and Military Affairs",
      "Worldwide Flash"
    ];
    
    // Count alerts for each predefined category
    const listsMap = new Map<string, number>();
    firstAlerts.forEach(alert => {
      if (alert.alertLists && Array.isArray(alert.alertLists)) {
        alert.alertLists.forEach(list => {
          listsMap.set(list, (listsMap.get(list) || 0) + 1);
        });
      }
    });
    
    // Build list with counts for all predefined categories
    return predefinedLists
      .map(name => ({ name, count: listsMap.get(name) || 0 }));
  }, [firstAlerts]);

  // Filter and sort first alerts based on selected command lists
  // Flash alerts at top (most recent first), then other alerts (most recent first)
  const filteredFirstAlerts = useMemo(() => {
    let filtered = firstAlerts;
    
    // Apply command list filter if any lists are selected
    if (selectedAlertLists.length > 0) {
      filtered = firstAlerts.filter(alert => {
        if (!alert.alertLists || alert.alertLists.length === 0) {
          return false; // Hide alerts with no lists when filter is active
        }
        // Show alert if it has at least one of the selected command lists
        return alert.alertLists.some(list => selectedAlertLists.includes(list));
      });
    }
    
    // Sort: Flash alerts first (most recent to oldest), then other alerts (most recent to oldest)
    return filtered.sort((a, b) => {
      const aIsFlash = a.alertType === 'Flash';
      const bIsFlash = b.alertType === 'Flash';
      
      // If one is Flash and the other isn't, Flash comes first
      if (aIsFlash && !bIsFlash) return -1;
      if (!aIsFlash && bIsFlash) return 1;
      
      // If both are Flash or both are not Flash, sort by publishedAt (most recent first)
      return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    });
  }, [firstAlerts, selectedAlertLists]);

  // Manual scrape mutation
  const scrapeMutation = useMutation({
    mutationFn: () => apiRequest('/api/scrape', 'POST', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ 
        predicate: (query) => query.queryKey[0] === '/api/headline-feed'
      });
      queryClient.invalidateQueries({ queryKey: ['/api/scrape-metadata'] });
    }
  });

  const refreshAllData = async () => {
    if (isRefreshing) return;
    
    try {
      setIsRefreshing(true);
      
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === '/api/headline-feed' });
      queryClient.invalidateQueries({ queryKey: ['/api/truth-social-posts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/x-posts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/rapidresponse-posts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/dowresponse-posts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/sentdefender-posts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/osint-posts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/first-alerts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/scrape-metadata'] });
    } catch (error) {
      console.error('Error refreshing data:', error);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    if (!autoRefresh) return;
    
    const interval = setInterval(() => {
      refreshAllData();
    }, 2 * 60 * 1000); // 2 minutes - just re-read from database

    return () => clearInterval(interval);
  }, [autoRefresh]);

  // Screen Wake Lock + Keep-Alive for display computers
  // Prevents screen sleep AND tab suspension for continuous operation
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    let keepAliveInterval: NodeJS.Timeout | null = null;

    // Acquire Screen Wake Lock to prevent display from sleeping
    const acquireWakeLock = async () => {
      if (!('wakeLock' in navigator)) {
        console.log('Screen Wake Lock API not supported');
        return;
      }

      try {
        wakeLock = await navigator.wakeLock.request('screen');
        console.log('Screen Wake Lock acquired - display will stay awake');

        wakeLock.addEventListener('release', () => {
          console.log('Screen Wake Lock released');
          wakeLock = null;
        });
      } catch (err) {
        console.error('Failed to acquire Screen Wake Lock:', err);
      }
    };

    // Release Wake Lock
    const releaseWakeLock = () => {
      if (wakeLock !== null) {
        wakeLock.release();
        wakeLock = null;
      }
    };

    // Keep-alive heartbeat to prevent browser tab suspension
    // Sends a lightweight ping every 5 minutes
    const startKeepAlive = () => {
      keepAliveInterval = setInterval(async () => {
        try {
          // Lightweight status check to keep tab active
          await fetch('/api/auth/status', { method: 'GET' });
          console.log('Keep-alive ping sent');
        } catch (err) {
          console.error('Keep-alive ping failed:', err);
        }
      }, 5 * 60 * 1000); // 5 minutes
    };

    // Handle visibility changes - re-acquire wake lock when tab becomes visible
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        console.log('Tab visible - reacquiring wake lock');
        acquireWakeLock();
      } else {
        console.log('Tab hidden - wake lock will auto-release');
      }
    };

    // Initialize
    acquireWakeLock();
    startKeepAlive();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Cleanup
    return () => {
      releaseWakeLock();
      if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []); // Run once on mount

  // Filter 18-hour headlines for Top Stories
  const filteredHeadlines18h = headlineFeed18h.filter(headline => {
    const matchesCategory = selectedCategories.length === 0 || selectedCategories.includes(headline.category);
    const matchesSearch = searchQuery === '' || 
      headline.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      headline.summary?.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  // Filter 48-hour headlines for All Headlines
  const filteredHeadlines48h = headlineFeed48h.filter(headline => {
    const matchesCategory = selectedCategories.length === 0 || selectedCategories.includes(headline.category);
    const matchesSearch = searchQuery === '' || 
      headline.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      headline.summary?.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  // Get top 8 stories from 18-hour feed (server already sorted by priority)
  const topStories: TopStoryProps[] = filteredHeadlines18h
    .slice(0, 8)
    .map(h => ({
      id: h.id,
      title: h.title,
      url: h.url,
      category: h.category,
      source: h.source,
      summary: h.summary,
      importance: (h.priorityScore >= 40 ? 'critical' : 'high') as 'critical' | 'high',
      timestamp: formatTimeAgo(h.scrapedAt)
    }));

  // Get IDs of headlines that are in top stories
  const topStoryIds = new Set(topStories.map(s => s.id));

  // Convert 48-hour headlines to display format (excluding those already in top stories)
  const allHeadlines: HeadlineCardProps[] = filteredHeadlines48h
    .filter(h => !topStoryIds.has(h.id))
    .map(h => ({
      id: h.id,
      title: h.title,
      url: h.url,
      category: h.category,
      timestamp: formatTimeAgo(h.scrapedAt),
      source: h.source,
      summary: h.summary,
      publishedDate: new Date(h.scrapedAt),
      tags: h.tags || [],
      pdfPath: h.pdfPath,
      priorityScore: h.priorityScore
    }));

  const handleClearFilters = () => {
    setSelectedCategories([]);
    setSearchQuery('');
  };

  const triggerManualScrape = async () => {
    if (isRefreshing) return;
    try {
      setIsRefreshing(true);
      await apiRequest('POST', '/api/scrape', {});
      await apiRequest('POST', '/api/scrape-truth-social', {});
      await apiRequest('POST', '/api/scrape-x', {});
      await apiRequest('POST', '/api/scrape-rapidresponse', {});
      await apiRequest('POST', '/api/scrape-dowresponse', {});
      await apiRequest('POST', '/api/scrape-first-alerts', {});
      refreshAllData();
    } catch (error) {
      console.error('Error triggering manual scrape:', error);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleManualRefresh = () => {
    triggerManualScrape();
  };

  const searchResults = useMemo(() => {
    if (!headerSearchQuery.trim()) return [];
    
    return (publicSearchData?.submissions || []).map((sub: any) => ({
      id: sub.id,
      headline: sub.headline,
      summary: sub.summary,
      url: sub.sourceUrl,
      sourceName: sub.sourceName,
      sourceTable: sub.sourceTable || 'team_submission',
      topicName: sub.topicName,
      priorityScore: sub.priorityScore,
      createdAt: sub.createdAt,
      publishedAt: sub.publishedAt
    }));
  }, [headerSearchQuery, publicSearchData]);
  
  const totalSearchResults = searchResults.length;

  if (isLoading) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-sm text-muted-foreground">Loading Media Common Operating Picture</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      <Header
        autoRefresh={autoRefresh}
        onAutoRefreshChange={setAutoRefresh}
        onManualRefresh={handleManualRefresh}
        isRefreshing={isRefreshing}
        onMcopBotClick={() => setMcopBotOpen(true)}
        searchQuery={headerSearchQuery}
        onSearchChange={setHeaderSearchQuery}
        onSearchSubmit={() => headerSearchQuery.trim() && setSearchDialogOpen(true)}
      />
      
      <div className="flex-1 overflow-auto">
        <div className="w-full px-6 py-3">
          {/* Column visibility toggles */}
          <div className="flex items-center gap-6 pb-2 border-b flex-wrap">
            <span className="text-xs font-medium text-muted-foreground">Show Columns:</span>
            <label className="flex items-center gap-2 cursor-pointer hover-elevate px-2 py-1 rounded-md">
              <input
                type="checkbox"
                checked={showTopStories}
                onChange={(e) => setShowTopStories(e.target.checked)}
                className="w-4 h-4 cursor-pointer"
                data-testid="toggle-top-stories"
              />
              <span className="text-xs">Top Stories</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer hover-elevate px-2 py-1 rounded-md">
              <input
                type="checkbox"
                checked={showTruthSocial}
                onChange={(e) => setShowTruthSocial(e.target.checked)}
                className="w-4 h-4 cursor-pointer"
                data-testid="toggle-truth-social"
              />
              <span className="text-xs">POTUS Truth Social</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer hover-elevate px-2 py-1 rounded-md">
              <input
                type="checkbox"
                checked={showSecWar}
                onChange={(e) => setShowSecWar(e.target.checked)}
                className="w-4 h-4 cursor-pointer"
                data-testid="toggle-secwar"
              />
              <span className="text-xs">@SecWar X</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer hover-elevate px-2 py-1 rounded-md">
              <input
                type="checkbox"
                checked={showSentDefender}
                onChange={(e) => setShowSentDefender(e.target.checked)}
                className="w-4 h-4 cursor-pointer"
                data-testid="toggle-sentdefender"
              />
              <span className="text-xs">OSINT X</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer hover-elevate px-2 py-1 rounded-md">
              <input
                type="checkbox"
                checked={showResponseFeed}
                onChange={(e) => setShowResponseFeed(e.target.checked)}
                className="w-4 h-4 cursor-pointer"
                data-testid="toggle-response-feed"
              />
              <span className="text-xs">Response Feed</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer hover-elevate px-2 py-1 rounded-md">
              <input
                type="checkbox"
                checked={showFirstAlert}
                onChange={(e) => setShowFirstAlert(e.target.checked)}
                className="w-4 h-4 cursor-pointer"
                data-testid="toggle-first-alert"
              />
              <span className="text-xs">DATAMINR</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer hover-elevate px-2 py-1 rounded-md">
              <input
                type="checkbox"
                checked={showTicker}
                onChange={(e) => setShowTicker(e.target.checked)}
                className="w-4 h-4 cursor-pointer"
                data-testid="toggle-ticker"
              />
              <span className="text-xs">Market Ticker</span>
            </label>
          </div>

          {showTicker && (
            <div className="-mx-6 mb-3">
              <MarketTicker enabled={showTicker} variant="dashboard" scrollDurationSeconds={58} />
            </div>
          )}

          <div className="flex gap-4">
            {/* Main content - Left side */}
            {showTopStories && (
            <div className="flex-1 space-y-3">
              {topStories.length > 0 && <TopStories stories={topStories} />}
              
              <div>
                <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                  <h2 className="text-sm font-semibold" data-testid="text-all-headlines-title">
                    All Headlines
                  </h2>
                  <span className="text-xs text-muted-foreground" data-testid="text-results-count">
                    {allHeadlines.length} headlines
                  </span>
                </div>
                
                {allHeadlines.length > 0 ? (
                  <HeadlineFeed headlines={allHeadlines} />
                ) : (
                  <div className="text-center py-8">
                    <p className="text-sm text-muted-foreground">No headlines available yet. Click "Refresh Now" to update.</p>
                  </div>
                )}
              </div>
              
              <FilterBar
                selectedCategories={selectedCategories}
                onCategoryChange={setSelectedCategories}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                onClearFilters={handleClearFilters}
              />
            </div>
            )}

            {/* Truth Social Feed - Middle */}
            {showTruthSocial && (
              <div className="w-96 xl:w-[34rem] flex-shrink-0 space-y-3">
                <div className="sticky top-3">
                  <div className="flex items-center justify-between mb-2">
                    <h2 className="text-sm font-semibold" data-testid="text-truth-social-title">
                      POTUS Truth Social
                    </h2>
                    <span className="text-xs text-muted-foreground" data-testid="text-truth-social-count">
                      {truthSocialPosts.length} posts
                    </span>
                  </div>
                  <div className="max-h-[calc(100vh-180px)] overflow-y-auto pr-2">
                    <TruthSocialFeed posts={truthSocialPosts.slice(0, 10)} />
                  </div>
                </div>
              </div>
            )}

            {/* X Posts Feed - Third column */}
            {showSecWar && (
              <div className="w-80 flex-shrink-0 space-y-3">
                <div className="sticky top-3">
                  <div className="flex items-center justify-between mb-2">
                    <h2 className="text-sm font-semibold" data-testid="text-x-posts-title">
                      @SecWar X
                    </h2>
                    <span className="text-xs text-muted-foreground" data-testid="text-x-posts-count">
                      {xPosts.length} posts
                    </span>
                  </div>
                  <div className="max-h-[calc(100vh-180px)] overflow-y-auto pr-2">
                    <XPostsFeed posts={xPosts.slice(0, 10)} />
                  </div>
                </div>
              </div>
            )}

            {/* OSINT Feeds Column - Between SecWar and Response Feed */}
            {showSentDefender && (() => {
              const OSINT_FEED_OPTIONS = [
                { id: 'sentdefender', label: '@sentdefender' },
                { id: 'MATA_osint', label: '@MATA_osint' },
                { id: 'CENTCOM', label: '@CENTCOM' },
                { id: 'SOUTHCOM', label: '@SOUTHCOM' },
                { id: 'flightTracking', label: 'Other Flight Tracking' },
              ];
              const combinedOsintPosts = [
                ...(selectedOsintFeeds.includes('sentdefender') ? sentDefenderPosts.map(p => ({
                  id: p.id, postId: p.postId, content: p.content, postedAt: p.postedAt,
                  xUrl: p.xUrl, sourceAccount: 'sentdefender', imageUrl: p.imageUrl, videoUrl: p.videoUrl,
                })) : []),
                ...osintPosts.filter(p => selectedOsintFeeds.includes(p.sourceAccount)).map(p => ({
                  id: p.id, postId: p.postId, content: p.content, postedAt: p.postedAt,
                  xUrl: p.xUrl, sourceAccount: p.sourceAccount, imageUrl: p.imageUrl, videoUrl: p.videoUrl,
                })),
                ...(selectedOsintFeeds.includes('flightTracking') ? flightTrackingPosts.map((p: any) => ({
                  id: p.id, postId: p.postId, content: p.content, postedAt: p.postedAt,
                  xUrl: p.xUrl, sourceAccount: 'flightTracking', originalAccount: p.sourceAccount,
                  imageUrl: p.imageUrl || p.screenshotUrl, videoUrl: null,
                })) : []),
              ].sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime());

              return (
              <div className="w-80 flex-shrink-0 space-y-3">
                <div className="sticky top-3">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <h2 className="text-sm font-semibold" data-testid="text-sentdefender-title">
                      OSINT X
                    </h2>
                    <div className="flex items-center gap-2">
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button variant="outline" size="sm" data-testid="button-osint-feeds">
                            Feeds
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-48 p-2" align="end">
                          <div className="space-y-1">
                            {OSINT_FEED_OPTIONS.map(opt => (
                              <label key={opt.id} className="flex items-center gap-2 cursor-pointer hover-elevate px-2 py-1.5 rounded-md">
                                <input
                                  type="checkbox"
                                  checked={selectedOsintFeeds.includes(opt.id)}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSelectedOsintFeeds(prev => [...prev, opt.id]);
                                    } else {
                                      setSelectedOsintFeeds(prev => prev.filter(f => f !== opt.id));
                                    }
                                  }}
                                  className="w-4 h-4 cursor-pointer"
                                  data-testid={`toggle-osint-feed-${opt.id}`}
                                />
                                <span className="text-xs">{opt.label}</span>
                              </label>
                            ))}
                          </div>
                        </PopoverContent>
                      </Popover>
                      <span className="text-xs text-muted-foreground" data-testid="text-sentdefender-count">
                        {combinedOsintPosts.length} posts
                      </span>
                    </div>
                  </div>
                  <div className="max-h-[calc(100vh-180px)] overflow-y-auto pr-2">
                    <SentDefenderFeed posts={combinedOsintPosts.slice(0, 15)} />
                  </div>
                </div>
              </div>
              );
            })()}

            {/* Combined Response Posts Feed - Fourth column */}
            {showResponseFeed && (
              <div className="w-80 flex-shrink-0 space-y-3">
                <div className="sticky top-3">
                  <div className="flex items-center justify-between mb-2">
                    <h2 className="text-sm font-semibold" data-testid="text-combined-posts-title">
                      Response Feed
                    </h2>
                    <span className="text-xs text-muted-foreground" data-testid="text-combined-posts-count">
                      {rapidResponsePosts.length + dowResponsePosts.length} posts
                    </span>
                  </div>
                  <div className="max-h-[calc(100vh-180px)] overflow-y-auto pr-2">
                    <CombinedResponseFeed 
                      rapidResponsePosts={rapidResponsePosts.slice(0, 10)} 
                      dowResponsePosts={dowResponsePosts.slice(0, 10)}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* First Alert Feed - Fifth column */}
            {showFirstAlert && (
              <div className="w-72 flex-shrink-0 space-y-3">
                <div className="sticky top-3">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-semibold" data-testid="text-first-alert-title">
                        DATAMINR
                      </h2>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setListFilterOpen(true)}
                        className="h-6 w-6"
                        data-testid="button-filter-lists"
                      >
                        <Filter className="h-3 w-3" />
                      </Button>
                    </div>
                    <span className="text-xs text-muted-foreground" data-testid="text-first-alert-count">
                      {filteredFirstAlerts.length} alerts
                    </span>
                  </div>
                  <div className="max-h-[calc(100vh-180px)] overflow-y-auto pr-2">
                    <FirstAlertFeed alerts={filteredFirstAlerts.slice(0, 100)} />
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>

      {/* Command List Filter Dialog */}
      <TopicFilterDialog
        open={listFilterOpen}
        onOpenChange={setListFilterOpen}
        availableLists={availableAlertLists}
        selectedLists={selectedAlertLists}
        onListsChange={setSelectedAlertLists}
      />

      {/* Admin, Privacy & Terms Links */}
      <div className="fixed bottom-2 right-2 flex items-center gap-3">
        <a
          href="/terms"
          className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
          data-testid="link-terms"
        >
          Terms &amp; Conditions
        </a>
        <a
          href="/privacy"
          className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
          data-testid="link-privacy"
        >
          Privacy Policy
        </a>
      </div>

      <MCOPBotDialog open={mcopBotOpen} onOpenChange={setMcopBotOpen} />

      {/* Search Results Dialog */}
      <Dialog open={searchDialogOpen} onOpenChange={setSearchDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle data-testid="search-dialog-title">
              Search Results for "{headerSearchQuery}" ({totalSearchResults} found)
            </DialogTitle>
          </DialogHeader>
          
          <div className="flex-1 min-h-0 overflow-y-auto" style={{ maxHeight: '60vh' }}>
            <div className="space-y-4 pr-2">
              {totalSearchResults === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <p className="text-sm">No results found matching "{headerSearchQuery}"</p>
                </div>
              ) : (
                <>
                  {searchResults.length > 0 && (
                    <div className="space-y-2">
                      {searchResults.map((result: any) => (
                        <a
                          key={`search-${result.sourceTable}-${result.id}`}
                          href={result.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block p-3 rounded-md border hover-elevate"
                          data-testid={`search-result-${result.sourceTable}-${result.id}`}
                        >
                          <div className="flex items-start gap-2">
                            <div className="flex-1">
                              <h3 className="text-sm font-medium line-clamp-2">{result.headline}</h3>
                              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
                                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                  {result.sourceTable === 'team_submission' ? 'Team' :
                                   result.sourceTable === 'mcop_feed' ? 'MCOP' :
                                   result.sourceTable === 'headline' ? 'Headline' :
                                   result.sourceTable === 'rss_bot' ? 'RSS' : 'News'}
                                </Badge>
                                {result.sourceName && <span className="font-medium">{result.sourceName}</span>}
                                <span>•</span>
                                <span>{formatTimeAgo(new Date(result.publishedAt || result.createdAt))}</span>
                              </div>
                              {result.summary && (
                                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{result.summary}</p>
                              )}
                            </div>
                            <ExternalLink className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
                          </div>
                        </a>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <CuratedNudge />
    </div>
  );
}
