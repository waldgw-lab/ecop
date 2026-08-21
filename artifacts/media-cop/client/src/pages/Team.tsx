import { useEffect, useState, useRef, useCallback, useMemo, lazy, Suspense } from "react";
import DOMPurify from "dompurify";
import { unwrapSafeLink } from "@shared/safeLink";
import { PRIMARY_TOPICS, OTHER_EMERGING, inferPrimaryTopic, primaryTopicShortLabel } from "@shared/classificationVocab";
import { useAuth } from "@/hooks/use-auth";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ApiRequestError, queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Shield, LogOut, ChevronDown, ChevronRight, ExternalLink, Newspaper, Share2, FolderOpen, Clock, Search, Calendar as CalendarIcon, Settings2, Loader2, Plus, FolderInput, Mail, Trash2, Send, FileText, ClipboardList, Printer, Download, Upload, Users, Layers, MapPin, X, Copy, RotateCcw, MessageSquare, HelpCircle, Monitor, Plane, Quote, Database, Bot, Phone, Radio, Gauge, Star, Menu, Radar } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
const RichTextEditor = lazy(() => import("@/components/RichTextEditor").then(m => ({ default: m.RichTextEditor })));
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import mcopBotIcon from "@assets/generated_images/mcop_bot_robot_mascot_icon.png";
import mcopLogoWhite from "@assets/Logo5_WHITE_1782606805634.png";
import mcopLogoBlack from "@assets/Logo5_BLACK_1782606794585.png";
import { MCOPBotDialog } from "@/components/MCOPBotDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TopicSelectItems } from "@/lib/topicOrdering";
import { Link } from "wouter";
import ThemeToggle from "@/components/ThemeToggle";
import ViewSwitcher from "@/components/ViewSwitcher";
import { useTheme } from "@/components/ThemeProvider";
import { format, subHours, subDays, startOfDay, endOfDay } from "date-fns";
import type { ReviewData, ReviewSaveData } from "@/components/ReviewSubmissionDialog";
import type { XPostReviewData, XPostReviewSaveData } from "@/components/ReviewXPostDialog";
import { HeadlineManagementDialog } from "@/components/HeadlineManagementDialog";
import { ManagePOTUSPostsDialog } from "@/components/ManagePOTUSPostsDialog";
import { ManageXPostsDialog } from "@/components/ManageXPostsDialog";
// Heavy, on-demand dialogs are lazy-loaded so they stay out of the initial
// Team page bundle and only download when the user actually opens them.
const ReviewSubmissionDialog = lazy(() => import("@/components/ReviewSubmissionDialog").then(m => ({ default: m.ReviewSubmissionDialog })));
const ReviewXPostDialog = lazy(() => import("@/components/ReviewXPostDialog").then(m => ({ default: m.ReviewXPostDialog })));
const QuoteDatabaseDialog = lazy(() => import("@/components/QuoteDatabaseDialog").then(m => ({ default: m.QuoteDatabaseDialog })));
const SmsAlertsDialog = lazy(() => import("@/components/SmsAlertsDialog").then(m => ({ default: m.SmsAlertsDialog })));
const RelayTestPostsDialog = lazy(() => import("@/components/RelayTestPostsDialog").then(m => ({ default: m.RelayTestPostsDialog })));
const OutletOversightDialog = lazy(() => import("@/components/OutletOversightDialog").then(m => ({ default: m.OutletOversightDialog })));

interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  userProfileImage: string | null;
  message: string;
  createdAt: string;
}

interface TeamSubmission {
  id: string;
  chatMessageId: string | null;
  submittedBy: string;
  submittedByName: string;
  sourceType: string;
  sourceUrl: string;
  sourceName: string | null;
  headline: string;
  summary: string;
  subjectId: string | null;
  status: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  isRead: boolean;
  priorityScore: number | null;
  mcopSubmittedAt: string | null;
  joeEmailedAt: string | null;
  clusterId: string | null;
  isClusterRepresentative: boolean;
  isQuestionable: boolean;
  isMataOsint: boolean;
  flightTrackingPostedAt: string | null;
  clusterName?: string;
}

interface TeamSubject {
  id: string;
  name: string;
  description: string | null;
  origin: string;
  createdBy: string | null;
  createdAt: string;
  topicId: string | null;
  focusArea: string | null;
  submissions: TeamSubmission[];
  unreadCount: number;
  unreadNewsCount: number;
  unreadSocialCount: number;
  // Watch-topic detail fields (Task #1039)
  isPriorityWatch?: boolean | null;
  isBoloWatch?: boolean | null;
  lifecycleMode?: string | null;
  boostStrength?: string | null;
  orKeywords?: string[] | null;
  andKeywords?: string[] | null;
  notKeywords?: string[] | null;
  watchKeywords?: string[] | null;
  estimatedActiveUntil?: string | null;
  sourcePrompt?: string | null;
  watchTopicLabel?: string | null;
}

interface SubjectsResponse {
  active: TeamSubject[];
  archived: TeamSubject[];
}

// Display-only entry for the Active Topics panel: either a strategic-topic
// section header or one of the existing subject cards. The grouping is derived
// at read time and never persisted or fed to any matcher/feed.
type ActiveTopicEntry =
  | { kind: 'header'; id: string; label: string; count: number }
  | { kind: 'subject'; subject: TeamSubject };

// Minimal shape of a curated Top Stories row — only the fields the Team page's
// read-only "Curated only" panel renders. Sourced from the existing
// allowlist-gated /api/curated/top-stories endpoint.
interface CuratedTopStory {
  id: string;
  title: string;
  displayTitle?: string | null;
  source: string;
  url: string;
  category: string;
  primaryTopic?: string | null;
  sourceCount: number;
  articlePublishedAt: string | null;
  scrapedAt: string;
}

// Convert plain URLs in HTML content to clickable links
function linkifyHtml(html: string): string {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = DOMPurify.sanitize(html);
  
  // Process text nodes to find and linkify URLs
  const walker = document.createTreeWalker(tempDiv, NodeFilter.SHOW_TEXT, null);
  const textNodes: Text[] = [];
  
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode as Text);
  }
  
  // URL regex pattern
  const urlRegex = /(https?:\/\/[^\s<>"']+)/g;
  
  textNodes.forEach(textNode => {
    // Skip if parent is already an anchor tag
    if (textNode.parentElement?.tagName === 'A') return;
    
    const text = textNode.textContent || '';
    if (!urlRegex.test(text)) return;
    
    // Reset regex
    urlRegex.lastIndex = 0;
    
    // Create a fragment to hold the new content
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match;
    
    while ((match = urlRegex.exec(text)) !== null) {
      // Add text before the URL
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
      }
      
      // Create the link
      const link = document.createElement('a');
      link.href = match[0];
      link.textContent = match[0];
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      fragment.appendChild(link);
      
      lastIndex = match.index + match[0].length;
    }
    
    // Add remaining text
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
    }
    
    // Replace the text node with the fragment
    textNode.parentNode?.replaceChild(fragment, textNode);
  });
  
  return tempDiv.innerHTML;
}

interface TeamAccessResponse {
  authenticated: boolean;
  hasTeamAccess: boolean;
  reason: 'not_logged_in' | 'member' | 'not_org_member';
}

interface TeamMember {
  id: string;
  email: string;
  addedBy: string;
  addedAt: string;
}

interface TeamCluster {
  id: string;
  name: string;
  subjectId: string;
  memberCount: number;
}

interface SubmissionComment {
  id: string;
  submissionId: string;
  userId: string;
  userName: string;
  text: string;
  createdAt: string;
}

function SubmissionComments({ submissionId, commentInput, onCommentInputChange, onSubmitComment, isSubmitting, onDeleteComment, isDeletingComment }: {
  submissionId: string;
  commentInput: string;
  onCommentInputChange: (val: string) => void;
  onSubmitComment: () => void;
  isSubmitting: boolean;
  onDeleteComment: (commentId: string) => void;
  isDeletingComment: boolean;
}) {
  const { data: comments = [], isLoading } = useQuery<SubmissionComment[]>({
    queryKey: ['/api/team/submissions', submissionId, 'comments'],
    queryFn: async () => {
      const res = await fetch(`/api/team/submissions/${submissionId}/comments`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch comments');
      return res.json();
    },
  });

  return (
    <div className="mt-2 ml-6 pl-3 border-l-2 border-muted space-y-2" data-testid={`comments-section-${submissionId}`}>
      {isLoading ? (
        <div className="text-xs text-muted-foreground py-1">Loading comments...</div>
      ) : comments.length === 0 ? (
        <div className="text-xs text-muted-foreground py-1">No comments yet</div>
      ) : (
        comments.map((comment) => (
          <div key={comment.id} className="group/comment text-xs space-y-0.5" data-testid={`comment-${comment.id}`}>
            <div className="flex items-center gap-1.5">
              <span className="font-medium">{comment.userName}</span>
              <span className="text-muted-foreground">{format(new Date(comment.createdAt), 'MMM d, h:mm a')}</span>
              <span
                role="button"
                tabIndex={0}
                className="invisible group-hover/comment:visible cursor-pointer p-0.5 rounded-sm hover-elevate"
                onClick={() => { if (!isDeletingComment) onDeleteComment(comment.id); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !isDeletingComment) onDeleteComment(comment.id); }}
                data-testid={`button-delete-comment-${comment.id}`}
              >
                <Trash2 className="h-3 w-3 text-muted-foreground" />
              </span>
            </div>
            <p className="text-muted-foreground">{comment.text}</p>
          </div>
        ))
      )}
      <div className="flex items-center gap-1.5 pt-1">
        <Input
          placeholder="Add a comment..."
          value={commentInput}
          onChange={(e) => onCommentInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && commentInput.trim()) {
              e.preventDefault();
              onSubmitComment();
            }
          }}
          className="text-xs"
          data-testid={`input-comment-${submissionId}`}
        />
        <Button
          size="icon"
          variant="ghost"
          disabled={!commentInput.trim() || isSubmitting}
          onClick={onSubmitComment}
          data-testid={`button-submit-comment-${submissionId}`}
        >
          <Send className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

interface BotStatus {
  id: string;
  name: string;
  description: string;
  schedule: string;
  enabled: boolean;
}

interface BotControlData {
  bots: BotStatus[];
}

// Every app feature whose AI runs through the shared AI client and is therefore
// switched by the Team-page AI provider toggle. Used to list affected features
// in the switch-confirmation dialog. (The MCOP Bot Q&A assistant and the daily
// news-brief bot use their own AI connection and are not affected.)
const AI_PROVIDER_SWITCHED_FEATURES: string[] = [
  'Headline priority scoring',
  'Duplicate-headline clustering',
  'Curated "Top Stories" lane (clustering, classification, and summaries)',
  'Manual submission analysis (priority and tags)',
  'Article review and Auto-fill from URL',
  'Quote extraction',
  'Topic matching and FLASH: Top Stories',
  'Stream summaries and briefing cards',
  'X-post screenshot text extraction',
  'Custom MCOP priority scoring',
  'Global Narrative Summary and Leadership Quotes',
  'News posting bots (Drudge, BBC, Fox, ABC, CBS, NBC, AP, Reuters, RSS)',
];


// ─────────────────────────────────────────────────────────────────────────────

export default function Team() {
  const { user, isLoading, logout, isLoggingOut } = useAuth();
  const { toast } = useToast();
  const { theme } = useTheme();
  const [newMessage, setNewMessage] = useState("");
  const [expandedSubjects, setExpandedSubjects] = useState<Set<string>>(new Set());
  // Active Topics: group by strategic content-topic (display-only) + curated-only panel.
  const [groupByTopic, setGroupByTopic] = useState(true);
  const [curatedSectionOpen, setCuratedSectionOpen] = useState(false);
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchSortBy, setSearchSortBy] = useState<"date" | "relevance">("relevance");
  const [showSearchOptions, setShowSearchOptions] = useState(false);
  const [timeRange, setTimeRange] = useState<"all" | "1h" | "6h" | "24h" | "week" | "custom">("all");
  const [customDateRange, setCustomDateRange] = useState<{ from: Date | undefined; to: Date | undefined }>({ from: undefined, to: undefined });
  
  // Team access check
  const { data: teamAccess, isLoading: teamAccessLoading } = useQuery<TeamAccessResponse>({
    queryKey: ['/api/auth/team-access'],
    retry: false,
  });

  const { data: curatedAccess } = useQuery<{ hasCuratedAccess: boolean }>({
    queryKey: ['/api/auth/curated-access'],
    retry: false,
  });

  // Curated-only panel (Team page). Reads the EXISTING allowlist-gated curated
  // endpoint, fetched ONLY for users who already have curated access AND only
  // once they actually open the (collapsed-by-default) section — so it surfaces
  // nothing new, does zero work until requested, and preserves the curated
  // isolation wall. Read-only, and the exact same query key as the Curated page
  // so it shares that cache (no extra server load when warm).
  const { data: curatedTopStories } = useQuery<{ stories: CuratedTopStory[] }>({
    queryKey: ['/api/curated/top-stories', { hours: 24, limit: 100 }],
    enabled: !!curatedAccess?.hasCuratedAccess && curatedSectionOpen,
    staleTime: 60_000,
  });
  const curatedStories = curatedTopStories?.stories ?? [];

  const [mcopBotOpen, setMcopBotOpen] = useState(false);

  // File-descriptor capacity status — early warning for the EMFILE crash class.
  const { data: fdStatus } = useQuery<{
    current: number;
    limit: number;
    percent: number;
    threshold: number;
    available: boolean;
    samples: { timestamp: string; open: number; limit: number; percent: number }[];
  }>({
    queryKey: ['/api/team/fd-status'],
    refetchInterval: 45000,
    staleTime: 20000,
    enabled: teamAccess?.hasTeamAccess === true,
  });

  // Source Oversight surface (outlet registry + quarantine). The badge count
  // uses filter-metrics; the dialog itself owns the registry/quarantine queries.
  const [quarantineOpen, setQuarantineOpen] = useState(false);
  // Which Source Oversight tab to open on (Priority/BOLO pointer deep-links
  // to "watchtopics"); cleared on close so other openers land on the default.
  const [oversightInitialTab, setOversightInitialTab] = useState<string | undefined>(undefined);
  const [botControlOpen, setBotControlOpen] = useState(false);
  const { data: filterMetrics } = useQuery<{
    financeWeatherRescued: number;
    financeWeatherDropped: number;
    quarantined: number;
    updatedAt: string | null;
  }>({
    queryKey: ['/api/team/filter-metrics'],
    refetchInterval: 90000,
    staleTime: 45000,
    enabled: teamAccess?.hasTeamAccess === true,
  });

  // AI provider mode (Auto / OpenRouter / Internal AI) — global switch for the whole MCOP
  const { data: aiSettings } = useQuery<{ provider: 'openrouter' | 'internal' | 'auto'; mode: string; disabled: boolean; updatedAt: string | null }>({
    queryKey: ['/api/team/ai-settings'],
    enabled: teamAccess?.hasTeamAccess === true,
  });

  const aiProviderMutation = useMutation({
    mutationFn: async (provider: 'openrouter' | 'internal' | 'auto') => {
      return apiRequest('POST', '/api/team/ai-settings', { provider });
    },
    onSuccess: (_data, provider) => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/ai-settings'] });
      toast({
        title: 'AI source updated',
        description: provider === 'auto'
          ? 'Now on Auto — MCOP picks the healthy AI provider automatically.'
          : provider === 'internal'
            ? 'Now using Internal AI (with automatic fallback to OpenRouter).'
            : 'Now using OpenRouter (with automatic fallback to Internal AI).',
      });
    },
    onError: () => {
      toast({
        title: 'Could not switch AI source',
        description: 'Please try again.',
        variant: 'destructive',
      });
    },
  });
  const [pendingAiProvider, setPendingAiProvider] = useState<'openrouter' | 'internal' | 'auto' | null>(null);

  // Flight tracking upload state
  const [ftDialogOpen, setFtDialogOpen] = useState(false);
  const [ftXUrl, setFtXUrl] = useState('');
  const [ftScreenshotFile, setFtScreenshotFile] = useState<File | null>(null);
  const [ftScreenshotPreview, setFtScreenshotPreview] = useState<string | null>(null);
  const [ftAnalyzing, setFtAnalyzing] = useState(false);
  const [ftSaving, setFtSaving] = useState(false);
  const [ftAnalysis, setFtAnalysis] = useState<{
    sourceAccount: string;
    displayName: string;
    content: string;
    postedAt: string;
    hasEmbeddedImage: boolean;
    imageDescription: string | null;
    isRetweet: boolean;
    retweetedFrom: string | null;
    retweetCommentary: string | null;
    originalContent: string | null;
    postId: string;
    xUrl: string;
    screenshotUrl: string;
  } | null>(null);
  const [ftEditAccount, setFtEditAccount] = useState('');
  const [ftEditContent, setFtEditContent] = useState('');
  const [ftEditPostedAt, setFtEditPostedAt] = useState('');
  const [ftEditImageUrl, setFtEditImageUrl] = useState('');
  const ftFileInputRef = useRef<HTMLInputElement>(null);

  const handleFtScreenshotSelect = (file: File) => {
    setFtScreenshotFile(file);
    const reader = new FileReader();
    reader.onload = (e) => setFtScreenshotPreview(e.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleFtPaste = useCallback((e: ClipboardEvent) => {
    if (!ftDialogOpen) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) {
          handleFtScreenshotSelect(file);
          e.preventDefault();
          break;
        }
      }
    }
  }, [ftDialogOpen]);

  useEffect(() => {
    document.addEventListener('paste', handleFtPaste);
    return () => document.removeEventListener('paste', handleFtPaste);
  }, [handleFtPaste]);

  const handleFtAnalyze = async () => {
    if (!ftScreenshotFile || !ftXUrl) {
      toast({ title: 'Missing fields', description: 'Provide both a screenshot and X post URL', variant: 'destructive' });
      return;
    }
    setFtAnalyzing(true);
    try {
      const formData = new FormData();
      formData.append('screenshot', ftScreenshotFile);
      formData.append('xUrl', ftXUrl);
      const res = await fetch('/api/flight-tracking/analyze', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Analysis failed');
      }
      const data = await res.json();
      setFtAnalysis(data);
      setFtEditAccount(data.sourceAccount);
      setFtEditContent(data.content);
      setFtEditPostedAt(data.postedAt);
      setFtEditImageUrl('');
      toast({ title: 'Analysis complete', description: data.hasEmbeddedImage ? 'Image detected in post - paste the image URL below' : 'Review the extracted data below' });
    } catch (error: any) {
      toast({ title: 'Analysis failed', description: error.message, variant: 'destructive' });
    } finally {
      setFtAnalyzing(false);
    }
  };

  const handleFtSave = async () => {
    if (!ftAnalysis) return;
    setFtSaving(true);
    try {
      await apiRequest('POST', '/api/flight-tracking/posts', {
        postId: ftAnalysis.postId,
        content: ftEditContent,
        postedAt: ftEditPostedAt,
        xUrl: ftAnalysis.xUrl,
        sourceAccount: ftEditAccount,
        imageUrl: ftEditImageUrl || null,
        screenshotUrl: ftAnalysis.screenshotUrl,
      });
      queryClient.invalidateQueries({ queryKey: ['/api/flight-tracking/posts'] });
      toast({ title: 'Post saved', description: 'Flight tracking post added successfully' });
      setFtDialogOpen(false);
      setFtAnalysis(null);
      setFtXUrl('');
      setFtScreenshotFile(null);
      setFtScreenshotPreview(null);
      setFtEditAccount('');
      setFtEditContent('');
      setFtEditPostedAt('');
      setFtEditImageUrl('');
    } catch (error: any) {
      toast({ title: 'Save failed', description: error.message, variant: 'destructive' });
    } finally {
      setFtSaving(false);
    }
  };
  
  const [editingPriority, setEditingPriority] = useState<string | null>(null);
  const [priorityInputValue, setPriorityInputValue] = useState("");
  
  const [editingTopic, setEditingTopic] = useState<string | null>(null);
  const [newTopicInput, setNewTopicInput] = useState("");
  const [selectedChatTopic, setSelectedChatTopic] = useState<{ id: string; name: string } | null>(null);
  const [chatTopicPopoverOpen, setChatTopicPopoverOpen] = useState(false);
  const [newChatTopicInput, setNewChatTopicInput] = useState("");
  const [isQuestionableSource, setIsQuestionableSource] = useState(false);
  const [isMataOsintFlag, setIsMataOsintFlag] = useState(false);
  
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [submissionToDelete, setSubmissionToDelete] = useState<TeamSubmission | null>(null);

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [splitRatio, setSplitRatio] = useState(() => {
    const saved = localStorage.getItem('team-split-ratio');
    const val = saved ? parseFloat(saved) : 50;
    return isNaN(val) || val < 25 || val > 75 ? 50 : val;
  });
  const isDraggingSplit = useRef(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  const handleSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingSplit.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingSplit.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = Math.min(Math.max((x / rect.width) * 100, 25), 75);
      setSplitRatio(pct);
    };
    const handleMouseUp = () => {
      if (isDraggingSplit.current) {
        isDraggingSplit.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        setSplitRatio(prev => {
          localStorage.setItem('team-split-ratio', String(prev));
          return prev;
        });
      }
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);
  
  const [topicToDelete, setTopicToDelete] = useState<TeamSubject | null>(null);
  const [deleteTopicConfirmOpen, setDeleteTopicConfirmOpen] = useState(false);

  const [expandedComments, setExpandedComments] = useState<Set<string>>(new Set());
  const [commentInputs, setCommentInputs] = useState<Record<string, string>>({});
  
  // Cluster management state
  const [creatingClusterFor, setCreatingClusterFor] = useState<{ submissionId: string; subjectId: string } | null>(null);
  const [newClusterName, setNewClusterName] = useState("");
  
  // News Scrub state
  const [newsScrubOpen, setNewsScrubOpen] = useState(false);
  const [newsScrubFromDate, setNewsScrubFromDate] = useState<Date | undefined>(undefined);
  const [newsScrubToDate, setNewsScrubToDate] = useState<Date | undefined>(new Date());
  const [newsScrubFromTime, setNewsScrubFromTime] = useState("00:00");
  const [newsScrubToTime, setNewsScrubToTime] = useState(format(new Date(), "HH:mm"));
  const [newsScrubGenerating, setNewsScrubGenerating] = useState(false);
  const [newsScrubBolo, setNewsScrubBolo] = useState("");

  // Daily News Scrub Upload state
  const [scrubUploadOpen, setScrubUploadOpen] = useState(false);
  const scrubFileRef = useRef<HTMLInputElement>(null);
  const [scrubFileName, setScrubFileName] = useState<string>("");
  const [scrubCaoDate, setScrubCaoDate] = useState<Date | undefined>(new Date());
  const [scrubCaoTime, setScrubCaoTime] = useState(format(new Date(), "HH:mm"));
  const [scrubUploading, setScrubUploading] = useState(false);

  const { data: scrubArchive, refetch: refetchScrubArchive } = useQuery<any[]>({
    queryKey: ['/api/daily-news-scrub/archive'],
    enabled: scrubUploadOpen,
  });

  // Briefing Card state
  const [briefingCardOpen, setBriefingCardOpen] = useState(false);
  // Default from date to midnight today
  const [briefingCardFromDate, setBriefingCardFromDate] = useState<Date | undefined>(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today;
  });
  const [briefingCardToDate, setBriefingCardToDate] = useState<Date | undefined>(new Date());
  const [briefingCardFromTime, setBriefingCardFromTime] = useState("00:00");
  const [briefingCardToTime, setBriefingCardToTime] = useState(format(new Date(), "HH:mm"));
  const [briefingCardGenerating, setBriefingCardGenerating] = useState(false);
  const [briefingCardBolo, setBriefingCardBolo] = useState("");
  type BriefingSectionKey = 'priorityBriefing' | 'topNarratives' | 'stateNarratives' | 'potusMessaging' | 'aerialView' | 'additionalIntelligence';
  const BRIEFING_SECTION_LABELS: Record<BriefingSectionKey, string> = {
    priorityBriefing: 'Priority Briefing (Top Stories)',
    topNarratives: 'Top Narratives (Domestic & International)',
    stateNarratives: 'State-Controlled Narratives',
    potusMessaging: 'POTUS & Official Messaging',
    aerialView: 'Aerial View (Public News Radar)',
    additionalIntelligence: 'Additional Intelligence',
  };
  const ALL_BRIEFING_SECTIONS: BriefingSectionKey[] = [
    'priorityBriefing', 'topNarratives', 'stateNarratives',
    'potusMessaging', 'aerialView', 'additionalIntelligence',
  ];
  const [briefingCardSections, setBriefingCardSections] = useState<Set<BriefingSectionKey>>(
    new Set(ALL_BRIEFING_SECTIONS)
  );
  const toggleBriefingSection = (key: BriefingSectionKey) => {
    setBriefingCardSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Hide bots state
  const [hideBots, setHideBots] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  
  // Review feature state
  const [reviewEnabled, setReviewEnabled] = useState(() => {
    const stored = localStorage.getItem('mcop-review-enabled');
    return stored !== null ? stored === 'true' : true;
  });
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [reviewData, setReviewData] = useState<ReviewData | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  // A monotonic id + abort handle for the progressive review-link stream, so a new
  // submission supersedes an in-flight one: late NDJSON chunks from the older stream
  // are dropped (id mismatch) and its socket is aborted, instead of being allowed to
  // overwrite the dialog the newer submission just opened.
  const reviewRequestIdRef = useRef(0);
  const reviewAbortRef = useRef<AbortController | null>(null);
  const reviewSaveIdempotencyRef = useRef<string | null>(null);
  useEffect(() => () => { reviewAbortRef.current?.abort(); }, []);
  const [pendingReviewMessage, setPendingReviewMessage] = useState("");
  const [useUserSuppliedInfo, setUseUserSuppliedInfo] = useState(false);

  const [xPostReviewOpen, setXPostReviewOpen] = useState(false);
  const [xPostReviewData, setXPostReviewData] = useState<XPostReviewData | null>(null);
  const [pendingXPostMessage, setPendingXPostMessage] = useState("");
  const [xPostReviewLoading, setXPostReviewLoading] = useState(false);
  const [xPostSaving, setXPostSaving] = useState(false);

  // Manage Team Members state
  const [manageTeamOpen, setManageTeamOpen] = useState(false);
  const [smsAlertsOpen, setSmsAlertsOpen] = useState(false);

  const [quoteDatabaseOpen, setQuoteDatabaseOpen] = useState(false);
  const [relayMonitorOpen, setRelayMonitorOpen] = useState(false);
  const [newMemberEmail, setNewMemberEmail] = useState("");

  const hasTeamAccess = teamAccess?.hasTeamAccess === true;

  const { data: smsHealth } = useQuery<{ color: string; reasons: string[] }>({
    queryKey: ['/api/sms-alerts/health'],
    refetchInterval: 30_000,
    staleTime: 20_000,
    enabled: hasTeamAccess,
  });
  
  const { data: messages = [], isLoading: messagesLoading } = useQuery<ChatMessage[]>({
    queryKey: ['/api/team/chat'],
    refetchInterval: reviewDialogOpen || reviewLoading ? false : 8000,
    staleTime: 4000,
    enabled: hasTeamAccess,
  });

  const { data: subjectsData, isLoading: subjectsLoading } = useQuery<SubjectsResponse>({
    queryKey: ['/api/team/subjects'],
    refetchInterval: reviewDialogOpen || reviewLoading ? false : 20000,
    staleTime: 8000,
    enabled: hasTeamAccess,
  });

  const { data: joePriorityData, isLoading: joePriorityLoading } = useQuery<{
    joePriorities: Array<TeamSubject & { submissions: TeamSubmission[]; totalCount: number }>;
    archivedJoePriorities: Array<TeamSubject & { submissions: TeamSubmission[]; totalCount: number }>;
    boloItems: Array<TeamSubject & { submissions: TeamSubmission[]; totalCount: number }>;
    archivedBoloItems: Array<TeamSubject & { submissions: TeamSubmission[]; totalCount: number }>;
  }>({
    queryKey: ['/api/team/joe-priorities-bolo'],
    refetchInterval: 60000,
    staleTime: 30000,
    enabled: hasTeamAccess,
  });
  
  const { data: allTopics = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['/api/team/topics'],
    enabled: hasTeamAccess,
  });

  // Fetch all clusters for cluster management
  const { data: allClusters = [] } = useQuery<TeamCluster[]>({
    queryKey: ['/api/team-submissions/clusters-all'],
    enabled: hasTeamAccess,
  });

  const { data: topicClusteringStatus } = useQuery<{ enabled: boolean }>({
    queryKey: ['/api/topic-clusters/enabled'],
    enabled: hasTeamAccess,
  });
  const topicClusteringEnabled = topicClusteringStatus?.enabled ?? true;

  const toggleTopicClusteringMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      return apiRequest('POST', '/api/topic-clusters/toggle', { enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/topic-clusters/enabled'] });
      queryClient.invalidateQueries({ queryKey: ['/api/team-submissions/clusters-all'] });
      queryClient.invalidateQueries({ queryKey: ['/api/team-submissions'] });
    },
  });

  const { data: joePriorityMatchingStatus } = useQuery<{ enabled: boolean }>({
    queryKey: ['/api/joe-priority-matching/enabled'],
    enabled: hasTeamAccess,
  });
  const joePriorityMatchingEnabled = joePriorityMatchingStatus?.enabled ?? true;

  const toggleJoePriorityMatchingMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      return apiRequest('POST', '/api/joe-priority-matching/toggle', { enabled });
    },
    onSuccess: (_data, enabled) => {
      queryClient.invalidateQueries({ queryKey: ['/api/joe-priority-matching/enabled'] });
      toast({ title: enabled ? 'Auto-matching resumed' : 'Auto-matching paused' });
    },
    onError: () => {
      toast({ title: 'Failed to update auto-matching', variant: 'destructive' });
    },
  });


  const { data: botControlData } = useQuery<BotControlData>({
    queryKey: ['/api/bot-control/status'],
    enabled: hasTeamAccess && botControlOpen,
    refetchInterval: 30000,
    staleTime: 15000,
  });

  const toggleBotMutation = useMutation({
    mutationFn: async ({ botId, enabled }: { botId: string; enabled: boolean }) => {
      return apiRequest('POST', '/api/bot-control/toggle', { botId, enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/bot-control/status'] });
    },
  });

  const { data: teamMembersData = [], isLoading: teamMembersLoading } = useQuery<TeamMember[]>({
    queryKey: ['/api/team/members'],
    enabled: hasTeamAccess && manageTeamOpen,
  });

  const addTeamMemberMutation = useMutation({
    mutationFn: async (email: string) => {
      return await apiRequest('POST', '/api/team/members', { email });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/members'] });
      setNewMemberEmail("");
      toast({
        title: "Member added",
        description: "Team member has been added successfully.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to add team member",
        variant: "destructive",
      });
    },
  });

  const removeTeamMemberMutation = useMutation({
    mutationFn: async (id: string) => {
      return await apiRequest('DELETE', `/api/team/members/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/members'] });
      toast({
        title: "Member removed",
        description: "Team member has been removed.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to remove team member",
        variant: "destructive",
      });
    },
  });
  
  const activeSubjects = subjectsData?.active ?? [];
  const archivedSubjects = subjectsData?.archived ?? [];

  // Active Topics grouping (DISPLAY-ONLY). Each subject's strategic category is
  // derived at read time with the deterministic, no-AI inferPrimaryTopic helper
  // and used purely to insert section headers in this one panel. Nothing here is
  // stored, sent to any matcher, or able to affect how content surfaces to the
  // MCOP feeds. Cheap: ~regex over a handful of subjects, memoized.
  const activeRenderEntries = useMemo<ActiveTopicEntry[]>(() => {
    const SPECIAL_NAMES = ['MOST RECENT', 'FLASH: TOP STORIES'];
    const isSpecial = (name: string) => SPECIAL_NAMES.includes(name);
    const visible = activeSubjects.filter(s => s.submissions.length > 0 || isSpecial(s.name));
    const specialOrder: Record<string, number> = { 'MOST RECENT': 0, 'FLASH: TOP STORIES': 1 };
    const specials = visible
      .filter(s => isSpecial(s.name))
      .sort((a, b) => (specialOrder[a.name] ?? 99) - (specialOrder[b.name] ?? 99));
    const regulars = visible.filter(s => !isSpecial(s.name));

    if (!groupByTopic) {
      return [...specials, ...regulars].map(s => ({ kind: 'subject', subject: s } as ActiveTopicEntry));
    }

    const groups = new Map<string, TeamSubject[]>();
    for (const s of regulars) {
      const inferred = inferPrimaryTopic(s.name, ...s.submissions.slice(0, 8).map(sub => sub.headline)) || OTHER_EMERGING;
      const list = groups.get(inferred) ?? [];
      list.push(s);
      groups.set(inferred, list);
    }
    const orderedCats = [...PRIMARY_TOPICS, OTHER_EMERGING].filter(c => groups.has(c));
    const entries: ActiveTopicEntry[] = specials.map(s => ({ kind: 'subject', subject: s }));
    for (const cat of orderedCats) {
      const subs = groups.get(cat)!;
      entries.push({ kind: 'header', id: cat, label: cat, count: subs.length });
      for (const s of subs) entries.push({ kind: 'subject', subject: s });
    }
    return entries;
  }, [activeSubjects, groupByTopic]);

  // Sort submissions: unread news → unread social → read news → read social
  // Within each group, sort by priority score descending
  // Filter out clustered submissions that are not representatives (they only appear in cluster expansion)
  const filterClusteredSubmissions = (submissions: TeamSubmission[]) => {
    return submissions.filter(s => !s.clusterId || s.isClusterRepresentative);
  };

  const sortSubmissionsForTopic = (submissions: TeamSubmission[], topicName?: string) => {
    const filteredSubmissions = filterClusteredSubmissions(submissions);
    
    if (topicName === 'MOST RECENT') {
      return [...filteredSubmissions].sort((a, b) => {
        const aTime = new Date(a.publishedAt || a.createdAt).getTime();
        const bTime = new Date(b.publishedAt || b.createdAt).getTime();
        return bTime - aTime;
      });
    }
    
    const unreadNews = filteredSubmissions.filter(s => !s.isRead && s.sourceType !== 'social_media');
    const unreadSocial = filteredSubmissions.filter(s => !s.isRead && s.sourceType === 'social_media');
    const readNews = filteredSubmissions.filter(s => s.isRead && s.sourceType !== 'social_media');
    const readSocial = filteredSubmissions.filter(s => s.isRead && s.sourceType === 'social_media');
    
    const sortByPriority = (a: TeamSubmission, b: TeamSubmission) => 
      (b.priorityScore || 0) - (a.priorityScore || 0);
    
    return [
      ...unreadNews.sort(sortByPriority),
      ...unreadSocial.sort(sortByPriority),
      ...readNews.sort(sortByPriority),
      ...readSocial.sort(sortByPriority),
    ];
  };

  // These per-subject derivations (representative filtering, sorting, age split) are
  // pure functions of subjectsData / joePriorityData, which React Query keeps
  // referentially stable across polls when the underlying data hasn't changed
  // (structural sharing). Memoizing on those data references means the 5s chat poll
  // (which updates unrelated state) no longer forces this O(topics x submissions)
  // work to re-run on every render.
  // Filtered + ordered list of active topic cards shown in the sidebar (pinned topics
  // first, then any other topic with submissions). Memoized so the 5s chat poll and
  // 20s subjects poll don't re-filter/re-sort every topic on every render.
  const visibleActiveSubjects = useMemo(() => {
    return activeSubjects
      .filter(s => s.submissions.length > 0 || s.name === 'FLASH: TOP STORIES' || s.name === 'CJCS MENTIONS' || s.name === 'MOST RECENT' || s.name === 'MATA / OSINT SOCIAL MEDIA')
      .sort((a, b) => {
        const order: Record<string, number> = { 'MOST RECENT': 0, 'FLASH: TOP STORIES': 1, 'CJCS MENTIONS': 2, 'MATA / OSINT SOCIAL MEDIA': 3 };
        const aOrder = order[a.name] ?? 99;
        const bOrder = order[b.name] ?? 99;
        return aOrder - bOrder;
      });
  }, [activeSubjects]);

  const visibleArchivedSubjects = useMemo(() => {
    return archivedSubjects.filter(s => s.submissions.length > 0 || s.name === 'CJCS MENTIONS');
  }, [archivedSubjects]);

  const activeSortedSubmissionsMap = useMemo(() => {
    const map = new Map<string, TeamSubmission[]>();
    activeSubjects.forEach(subject => {
      map.set(subject.id, sortSubmissionsForTopic(subject.submissions, subject.name));
    });
    return map;
  }, [activeSubjects]);

  const archivedSortedSubmissionsMap = useMemo(() => {
    const map = new Map<string, TeamSubmission[]>();
    archivedSubjects.forEach(subject => {
      map.set(subject.id, sortSubmissionsForTopic(subject.submissions, subject.name));
    });
    return map;
  }, [archivedSubjects]);

  const getRelatedClusterSubmissions = (submissions: TeamSubmission[], currentSubmission: TeamSubmission) => {
    if (!currentSubmission.clusterId) return [];
    return submissions.filter(s => 
      s.clusterId === currentSubmission.clusterId && s.id !== currentSubmission.id
    );
  };

  const toggleCluster = (clusterId: string) => {
    setExpandedClusters(prev => {
      const next = new Set(prev);
      if (next.has(clusterId)) {
        next.delete(clusterId);
      } else {
        next.add(clusterId);
      }
      return next;
    });
  };

  const toggleSubject = (subjectId: string) => {
    setExpandedSubjects(prev => {
      const next = new Set(prev);
      if (next.has(subjectId)) {
        next.delete(subjectId);
      } else {
        next.add(subjectId);
      }
      return next;
    });
  };

  const sendMessageMutation = useMutation({
    mutationFn: async ({ message, topicId, newTopicName, isQuestionable, isMataOsint, reviewData, idempotencyKey }: { message: string; topicId?: string; newTopicName?: string; isQuestionable?: boolean; isMataOsint?: boolean; reviewData?: ReviewSaveData; idempotencyKey?: string }) => {
      const body = { message, topicId, newTopicName, isQuestionable, isMataOsint, reviewData, idempotencyKey };
      const maxAttempts = reviewData ? 5 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await apiRequest('POST', '/api/team/chat', body);
        } catch (error) {
          if (!reviewData || attempt === maxAttempts) throw error;
          const readinessRetry =
            error instanceof ApiRequestError &&
            error.status === 503 &&
            error.retryAfterMs != null;
          // Readiness failures honor the server's Retry-After guidance. One
          // non-HTTP/network failure keeps the historical single retry. Every
          // attempt reuses the IDENTICAL body + durable idempotency key.
          if (!readinessRetry && attempt > 1) throw error;
          const waitMs = readinessRetry
            ? Math.max(250, Math.min(error.retryAfterMs!, 5_000))
            : 750;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
      throw new Error('Reviewed save retry loop exhausted');
    },
    onSuccess: async (_, { message, topicId, newTopicName, reviewData }) => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/chat'] });
      setNewMessage("");
      setSelectedChatTopic(null);
      setIsQuestionableSource(false);
      setIsMataOsintFlag(false);
      // A brand-new topic is created synchronously on the server, so refresh the
      // topic list immediately and confirm it to the user.
      if (newTopicName && newTopicName.trim()) {
        queryClient.invalidateQueries({ queryKey: ['/api/team/subjects'] });
        queryClient.invalidateQueries({ queryKey: ['/api/team/topics'] });
        toast({
          title: "Topic saved",
          description: `Story filed under "${newTopicName.trim()}".`,
        });
      }
      // Refresh subjects after a delay to allow AI processing
      const hasUrl = /https?:\/\/[^\s]+/i.test(message);
      const hasTopicOverride = !!(topicId || newTopicName);
      if (hasUrl || hasTopicOverride) {
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ['/api/team/subjects'] });
          queryClient.invalidateQueries({ queryKey: ['/api/team/topics'] });
        }, 5000);
      }
      if (reviewData) {
        // The reviewed server path completes asynchronously after accepting chat.
        // Force a fresh read now (rather than waiting for the polling interval),
        // while retaining the delayed invalidation above for late AI work.
        await Promise.all([
          queryClient.refetchQueries({ queryKey: ['/api/team/chat'] }),
          queryClient.refetchQueries({ queryKey: ['/api/team/subjects'] }),
          queryClient.refetchQueries({ queryKey: ['/api/team/topics'] }),
        ]);
      }
    },
  });

  const postToFlightTrackingMutation = useMutation({
    mutationFn: async (submissionId: string) => {
      return apiRequest('POST', `/api/team/submissions/${submissionId}/post-to-flight-tracking`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/subjects'] });
      queryClient.invalidateQueries({ queryKey: ['/api/team/topics'] });
      queryClient.invalidateQueries({ queryKey: ['/api/flight-tracking/posts'] });
      toast({ title: "Posted to Flight Tracking", description: "Submission is now visible in Dashboard and Stream feeds." });
    },
    onError: (error: any) => {
      toast({ title: "Failed to post", description: error.message || "Could not post to flight tracking", variant: "destructive" });
    },
  });

  const deleteChatMessageMutation = useMutation({
    mutationFn: async (messageId: string) => {
      return apiRequest('DELETE', `/api/team/chat/${messageId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/chat'] });
      toast({ title: "Message Deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to Delete", description: error.message, variant: "destructive" });
    },
  });

  const handleCopyChatMessage = async (msg: ChatMessage) => {
    try {
      const htmlBlob = new Blob([msg.message], { type: 'text/html' });
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = msg.message;
      const plainText = tempDiv.textContent || tempDiv.innerText || '';
      const textBlob = new Blob([plainText], { type: 'text/plain' });
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': htmlBlob,
          'text/plain': textBlob,
        }),
      ]);
      toast({ title: "Copied to Clipboard" });
    } catch {
      try {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = msg.message;
        await navigator.clipboard.writeText(tempDiv.textContent || tempDiv.innerText || '');
        toast({ title: "Copied to Clipboard" });
      } catch {
        toast({ title: "Failed to Copy", variant: "destructive" });
      }
    }
  };

  const toggleReadMutation = useMutation({
    mutationFn: async (submissionId: string) => {
      return apiRequest('POST', `/api/team/submissions/${submissionId}/read`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/subjects'] });
    },
  });

  const allSubmissionIds = (subjectsData?.active || []).flatMap(s => s.submissions.map(sub => sub.id));
  // Comment-count badges only render inside an expanded "active" topic's Collapsible
  // content, so there's no need to poll this in the background while every topic is
  // collapsed (the default state).
  const hasExpandedActiveSubject = Array.from(expandedSubjects).some(key => key.startsWith('active-'));
  const { data: commentCounts = {} } = useQuery<Record<string, number>>({
    queryKey: ['/api/team/submissions/comment-counts', allSubmissionIds.join(',')],
    queryFn: async () => {
      if (allSubmissionIds.length === 0) return {};
      const res = await apiRequest('POST', '/api/team/submissions/comment-counts', { submissionIds: allSubmissionIds });
      return res.json();
    },
    enabled: hasTeamAccess && allSubmissionIds.length > 0 && hasExpandedActiveSubject,
    staleTime: 15000,
    refetchInterval: 30000,
  });

  const addCommentMutation = useMutation({
    mutationFn: async ({ submissionId, text }: { submissionId: string; text: string }) => {
      const res = await apiRequest('POST', `/api/team/submissions/${submissionId}/comments`, { text });
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/submissions/comment-counts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/team/submissions', variables.submissionId, 'comments'] });
      setCommentInputs(prev => ({ ...prev, [variables.submissionId]: '' }));
    },
  });

  const deleteCommentMutation = useMutation({
    mutationFn: async ({ submissionId, commentId }: { submissionId: string; commentId: string }) => {
      return apiRequest('DELETE', `/api/team/submissions/${submissionId}/comments/${commentId}`);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/submissions/comment-counts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/team/submissions', variables.submissionId, 'comments'] });
      toast({ title: "Comment Deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Delete Failed", description: error.message, variant: "destructive" });
    },
  });

  const submitToMcopMutation = useMutation({
    mutationFn: async (submissionId: string) => {
      return apiRequest('POST', `/api/team/submissions/${submissionId}/mcop`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/headline-feed'] });
      queryClient.invalidateQueries({ queryKey: ['/api/team/subjects'] });
      toast({
        title: "Submitted to MCOP",
        description: "Article has been added to the primary news feed."
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Submission Failed",
        description: error.message,
        variant: "destructive"
      });
    }
  });
  
  const updatePriorityMutation = useMutation({
    mutationFn: async ({ submissionId, priorityScore }: { submissionId: string; priorityScore: number }) => {
      const response = await apiRequest('PATCH', `/api/team/submissions/${submissionId}/priority`, { priorityScore });
      return response.json();
    },
    onSuccess: (data: { success: boolean; flashAssigned: boolean }) => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/subjects'] });
      queryClient.invalidateQueries({ queryKey: ['/api/headline-feed'] });
      if (data.flashAssigned) {
        toast({
          title: "Priority Updated - FLASH Assigned",
          description: "This item has been added to FLASH: TOP STORIES and submitted to MCOP."
        });
      } else {
        toast({
          title: "Priority Updated",
          description: "The priority score has been updated."
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Update Failed",
        description: error.message,
        variant: "destructive"
      });
    },
  });

  const toggleQuestionableMutation = useMutation({
    mutationFn: async ({ submissionId, isQuestionable }: { submissionId: string; isQuestionable: boolean }) => {
      const response = await apiRequest('PATCH', `/api/team/submissions/${submissionId}/questionable`, { isQuestionable });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/subjects'] });
      toast({
        title: "Source Updated",
        description: "Questionable source status has been updated."
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Update Failed",
        description: error.message,
        variant: "destructive"
      });
    },
  });

  const changeTopicMutation = useMutation({
    mutationFn: async ({ submissionId, topicId, newTopicName }: { submissionId: string; topicId?: string; newTopicName?: string }) => {
      const response = await apiRequest('PATCH', `/api/team/submissions/${submissionId}/topic`, { topicId, newTopicName });
      return response.json();
    },
    onSuccess: (data: { success: boolean; topicName: string }) => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/subjects'] });
      queryClient.invalidateQueries({ queryKey: ['/api/team/topics'] });
      setEditingTopic(null);
      setNewTopicInput("");
      toast({
        title: "Topic Changed",
        description: `Item moved to "${data.topicName}".`
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Change Topic",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  // Cluster management mutations
  const assignToClusterMutation = useMutation({
    mutationFn: async ({ submissionId, clusterId }: { submissionId: string; clusterId: string }) => {
      return apiRequest('POST', '/api/team-submissions/clusters/assign', { submissionId, clusterId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/subjects'] });
      queryClient.invalidateQueries({ queryKey: ['/api/team-submissions/clusters-all'] });
      toast({
        title: "Added to Cluster",
        description: "Headline has been added to the cluster."
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Add to Cluster",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const createClusterMutation = useMutation({
    mutationFn: async ({ submissionId, clusterName, subjectId }: { submissionId: string; clusterName: string; subjectId: string }) => {
      return apiRequest('POST', '/api/team-submissions/clusters/create', { submissionId, clusterName, subjectId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/subjects'] });
      queryClient.invalidateQueries({ queryKey: ['/api/team-submissions/clusters-all'] });
      setCreatingClusterFor(null);
      setNewClusterName("");
      toast({
        title: "Cluster Created",
        description: "New cluster has been created with this headline."
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Create Cluster",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const unlinkFromClusterMutation = useMutation({
    mutationFn: async (submissionId: string) => {
      return apiRequest('POST', '/api/team-submissions/clusters/unlink', { submissionId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/subjects'] });
      queryClient.invalidateQueries({ queryKey: ['/api/team-submissions/clusters-all'] });
      toast({
        title: "Removed from Cluster",
        description: "Headline has been removed from the cluster."
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Remove from Cluster",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const deleteSubmissionMutation = useMutation({
    mutationFn: async (submissionId: string) => {
      const response = await apiRequest('DELETE', `/api/team/submissions/${submissionId}`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/subjects'] });
      queryClient.invalidateQueries({ queryKey: ['/api/team/topics'] });
      setDeleteConfirmOpen(false);
      setSubmissionToDelete(null);
      toast({
        title: "Deleted",
        description: "The submission has been removed and will not appear again."
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Delete",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const deleteTopicMutation = useMutation({
    mutationFn: async (topicId: string) => {
      const response = await apiRequest('DELETE', `/api/team/subjects/${topicId}`);
      return response.json();
    },
    onSuccess: (data: { success: boolean; message: string }) => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/subjects'] });
      queryClient.invalidateQueries({ queryKey: ['/api/team/topics'] });
      setDeleteTopicConfirmOpen(false);
      setTopicToDelete(null);
      toast({
        title: "Topic Deleted",
        description: data.message
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Delete Topic",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  // Open email draft in Outlook/email client for Joe
  const joeMarkMutation = useMutation({
    mutationFn: async (submissionId: string) => {
      await apiRequest("POST", `/api/team/submissions/${submissionId}/joe-mark`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/submissions'] });
    }
  });

  const openJoeEmailDraft = (submission: TeamSubmission) => {
    const toRecipients = [
      'joseph.r.holstead.civ@mail.mil',
      'william.j.dixon60.civ@mail.mil'
    ];
    const ccRecipients = [
      'js.pentagon.ocjcs.list.joint-staff-public-affairs-all@mail.mil',
      'js.pentagon.ocjcs.mbx.public-affairs-media-analysis@mail.mil'
    ];
    
    const publishedDate = submission.publishedAt || submission.createdAt;
    const formattedDate = new Date(publishedDate).toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    });
    
    const subject = `MCOP Alert: ${submission.headline} - ${submission.sourceName || 'Unknown Source'}`;
    const body = `MCOP Alert

Headline: ${submission.headline}

Source: ${submission.sourceName || 'Unknown Source'}

Date/Time: ${formattedDate}

Summary:
${submission.summary || 'No summary available.'}

Read Full Article: ${submission.sourceUrl}

---
This alert was drafted from the Media Common Operating Picture (MCOP) system.`;

    const mailtoUrl = `mailto:${toRecipients.join(';')}?cc=${ccRecipients.join(';')}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    
    window.open(mailtoUrl, '_blank');
    
    joeMarkMutation.mutate(submission.id);
    
    toast({
      title: "Email Draft Opened",
      description: "Your email client should open with the draft ready to send."
    });
  };

  useEffect(() => {
    // Only redirect to login if not authenticated AND team access check shows not logged in
    if (!teamAccessLoading && teamAccess?.reason === 'not_logged_in') {
      window.location.href = "/api/login";
    }
  }, [teamAccessLoading, teamAccess]);

  // Track whether the user is near the bottom of the chat *before* new content
  // arrives. Measuring after a tall message renders would over-count the
  // distance and wrongly suppress auto-follow, so we keep a live signal here.
  const isNearBottomRef = useRef(true);
  useEffect(() => {
    const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]",
    );
    if (!viewport) return;
    const updateNearBottom = () => {
      const distance =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      isNearBottomRef.current = distance < 120;
    };
    viewport.addEventListener("scroll", updateNearBottom, { passive: true });
    updateNearBottom();
    return () => viewport.removeEventListener("scroll", updateNearBottom);
  }, [hasTeamAccess]);

  const lastMessageSigRef = useRef<string>("");
  useEffect(() => {
    if (messages.length === 0) {
      lastMessageSigRef.current = "";
      return;
    }
    // TanStack Query returns a brand-new array reference on every poll (the chat
    // refetches every 5s), even when the data is identical. Scrolling on every
    // run smooth-scrolled the chat every 5s and yanked focus/scroll away from the
    // composer, making it impossible to review/submit. Only react to a genuinely
    // new message (length or newest id changed).
    const sig = `${messages.length}:${messages[messages.length - 1]?.id ?? ""}`;
    if (sig === lastMessageSigRef.current) return;
    const isInitial = lastMessageSigRef.current === "";
    lastMessageSigRef.current = sig;

    const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]",
    );
    if (isInitial) {
      // Jump straight to the newest message on first load.
      if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior: "auto" });
      else messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
      return;
    }
    // On a genuine new message, only follow it if the user was already near the
    // bottom — never pull them down while they've scrolled up to read or compose.
    if (viewport && isNearBottomRef.current) {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
    }
  }, [messages]);

  const handleToggleReview = () => {
    const next = !reviewEnabled;
    setReviewEnabled(next);
    localStorage.setItem('mcop-review-enabled', String(next));
  };

  // Bounded retry for the pre-submit AI review calls. A transient provider
  // rate-limit (server responds 503 { retryable }) or a network blip should not
  // kill an article submission, so re-attempt the IDENTICAL request a few times
  // with backoff. Genuine failures (400 bad URL, 422 unanalyzable, 409 dup, 500)
  // are returned immediately and never retried — real problems are never masked.
  // Same endpoint / model / prompt, so analysis quality is unchanged.
  const fetchReviewWithRetry = async (
    input: string,
    init: RequestInit,
    onRetry?: (attempt: number) => void,
  ): Promise<Response> => {
    const MAX_ATTEMPTS = 3;
    const BACKOFF_MS = [1200, 2500];
    let lastErr: any;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(input, init);
        if (resp.status === 503 && attempt < MAX_ATTEMPTS) {
          onRetry?.(attempt);
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
          continue;
        }
        return resp;
      } catch (err) {
        if ((err as any)?.name === 'AbortError') throw err; // intentional cancel — never retry
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          onRetry?.(attempt);
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
          continue;
        }
        throw lastErr;
      }
    }
    throw lastErr;
  };

  const handleSendMessage = async () => {
    const hasContent = newMessage !== '<p></p>' && newMessage.trim() !== '';
    if (!hasContent || sendMessageMutation.isPending || reviewLoading || xPostReviewLoading) return;

    const hrefMatch = newMessage.match(/href=["'](https?:\/\/[^"']+)["']/i);
    const plainText = newMessage.replace(/<[^>]*>/g, '');
    const plainUrlMatch = plainText.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/i);
    const rawUrlMatch = hrefMatch ? [hrefMatch[1]] : plainUrlMatch;
    // Unwrap any safe-link / isolation-proxy wrapper (e.g. Menlo) so what is
    // displayed and sent is the real article URL. The server unwrap remains
    // authoritative; this just keeps the client in sync. No-op for normal links.
    const urlMatch = rawUrlMatch ? [unwrapSafeLink(rawUrlMatch[0])] : rawUrlMatch;
    const isXUrl = urlMatch && (urlMatch[0].includes('x.com') || urlMatch[0].includes('twitter.com'));
    const shouldReviewXPost = reviewEnabled && isMataOsintFlag && isXUrl && urlMatch;
    const shouldReview = reviewEnabled && !isQuestionableSource && !isMataOsintFlag && urlMatch;

    if (shouldReviewXPost) {
      const extractedUrl = urlMatch[0];
      setXPostReviewLoading(true);
      setPendingXPostMessage(newMessage);
      try {
        const resp = await fetchReviewWithRetry(
          '/api/team/chat/review-x-post',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ url: extractedUrl }),
          },
          () => toast({ title: "Service busy — retrying", description: "Re-attempting your submission in a moment…" }),
        );
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({ error: 'Scrape failed' }));
          toast({ title: "X Post Review Failed", description: errData.error || 'Could not scrape X post', variant: "destructive" });
          setXPostReviewLoading(false);
          return;
        }
        const data = await resp.json();
        setXPostReviewData({
          text: data.text,
          author: data.author,
          imageUrl: data.imageUrl,
          videoUrl: data.videoUrl || null,
          postedAt: data.postedAt || null,
          url: extractedUrl,
        });
        setXPostReviewOpen(true);
      } catch (err: any) {
        toast({ title: "X Post Review Error", description: err.message || 'Network error', variant: "destructive" });
      } finally {
        setXPostReviewLoading(false);
      }
    } else if (shouldReview) {
      const extractedUrl = urlMatch[0];
      // Supersede any in-flight review stream: abort it and tag this request with a
      // fresh monotonic id so its late chunks can't clobber the new dialog.
      reviewAbortRef.current?.abort();
      const myReviewId = ++reviewRequestIdRef.current;
      reviewSaveIdempotencyRef.current =
        globalThis.crypto?.randomUUID?.() ??
        `review-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const reviewController = new AbortController();
      reviewAbortRef.current = reviewController;
      setReviewLoading(true);
      setPendingReviewMessage(newMessage);
      try {
        const resp = await fetchReviewWithRetry(
          '/api/team/chat/review-link',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            signal: reviewController.signal,
            body: JSON.stringify({
              url: extractedUrl,
              message: plainText,
              useUserInfo: useUserSuppliedInfo,
              userText: useUserSuppliedInfo ? plainText.replace(extractedUrl, '').trim() : '',
            }),
          },
          () => toast({ title: "AI busy — retrying", description: "The AI is briefly rate-limited; re-attempting your submission…" }),
        );
        if (!resp.ok) {
          if (myReviewId !== reviewRequestIdRef.current) return; // superseded — don't toast over the newer request
          const errData = await resp.json().catch(() => ({ error: '' }));
          toast({ title: "Review Failed", description: errData.error || "Couldn't analyze that link in time — it may be slow, paywalled, or blocking automated access. You can still post it manually.", variant: "destructive" });
          setReviewLoading(false);
          return;
        }

        // The review endpoint streams its result progressively as NDJSON:
        //  - `meta` arrives first → open the dialog immediately (headline, image,
        //    topic, source).
        //  - `priority` and `bullets` arrive as each finishes → fill those fields
        //    in without blocking the dialog.
        // Falls back gracefully: if the response isn't an NDJSON stream (no body
        // reader, or a plain JSON content type), parse it as a single JSON object
        // so legacy / non-streaming responses still open the dialog.
        const isNdjson = (resp.headers.get('content-type') || '').includes('ndjson');
        if (!resp.body || !isNdjson) {
          const data: ReviewData = await resp.json();
          if (myReviewId !== reviewRequestIdRef.current) return;
          setReviewData(data);
          setReviewDialogOpen(true);
          setReviewLoading(false);
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let opened = false;
        let accumulated: ReviewData | null = null;

        const handleEvent = (evt: any) => {
          if (myReviewId !== reviewRequestIdRef.current) return; // a newer review superseded this stream
          if (!evt || typeof evt !== 'object') return;
          if (evt.type === 'ping') {
            return; // heartbeat — keeps the stream alive, nothing to render
          } else if (evt.type === 'init') {
            // Dialog opens IMMEDIATELY with just the link + the user's own text.
            // Headline/source/image and priority/bullets/classification each
            // stream in afterward (or fall back to manual entry). The link is
            // never dropped: the dialog is usable from this moment on.
            accumulated = {
              headline: '',
              summary: '',
              ogImageUrl: null,
              summaryBullets: [],
              articleText: '',
              priorityScore: 50,
              tags: [],
              suggestedTopic: '',
              sourceName: evt.sourceName || 'News Source',
              sourceType: evt.sourceType || 'news',
              publishedAt: null,
              existingTopics: evt.existingTopics || [],
              metadataError: null,
              _loading: { metadata: true, priority: true, bullets: true, classification: true },
            };
            setReviewData(accumulated);
            setReviewDialogOpen(true);
            setReviewLoading(false);
            opened = true;
          } else if (evt.type === 'metadata' && accumulated) {
            accumulated = {
              ...accumulated,
              headline: evt.headline || accumulated.headline || '',
              headlineGenerated: evt.headlineGenerated,
              headlineSource: evt.headlineSource,
              summary: evt.summary || accumulated.summary || '',
              ogImageUrl: evt.ogImageUrl ?? accumulated.ogImageUrl ?? null,
              suggestedTopic: evt.suggestedTopic || accumulated.suggestedTopic || '',
              sourceName: evt.sourceName || accumulated.sourceName || 'News Source',
              sourceType: evt.sourceType || accumulated.sourceType || 'news',
              publishedAt: evt.publishedAt ?? accumulated.publishedAt ?? null,
              metadataError: null,
              _loading: { ...accumulated._loading!, metadata: false },
            };
            setReviewData(accumulated);
          } else if (evt.type === 'metadata_error' && accumulated) {
            // Auto-fill couldn't read the link (slow/paywalled/blocked). Keep the
            // dialog open and usable so the user fills in the details manually.
            accumulated = {
              ...accumulated,
              metadataError: evt.error || 'Auto-fill could not finish. Fill in the details and post manually.',
              _loading: { ...accumulated._loading!, metadata: false },
            };
            setReviewData(accumulated);
          } else if (evt.type === 'priority' && accumulated) {
            // Priority streams in two phases: a fast headline-based score first,
            // then (evt.refined) a body-aware upgrade. Both flow through here —
            // the dialog re-applies the latest value unless the reviewer edited it.
            accumulated = {
              ...accumulated,
              priorityScore: typeof evt.priorityScore === 'number' ? evt.priorityScore : 50,
              tags: Array.isArray(evt.tags) ? evt.tags : [],
              _loading: { ...accumulated._loading!, priority: false },
            };
            setReviewData(accumulated);
          } else if (evt.type === 'bullets' && accumulated) {
            accumulated = {
              ...accumulated,
              summaryBullets: Array.isArray(evt.summaryBullets) ? evt.summaryBullets : [],
              articleText: typeof evt.articleText === 'string' ? evt.articleText : '',
              _loading: { ...accumulated._loading!, bullets: false },
            };
            setReviewData(accumulated);
          } else if (evt.type === 'classification' && accumulated) {
            accumulated = {
              ...accumulated,
              suggestedPrimaryTopic: evt.suggestedPrimaryTopic ?? null,
              suggestedConflictTrack: evt.suggestedConflictTrack ?? null,
              suggestedRegion: evt.suggestedRegion ?? null,
              suggestedCountry: evt.suggestedCountry ?? null,
              suggestedCountryPair: evt.suggestedCountryPair ?? null,
              _loading: { ...accumulated._loading!, classification: false },
            };
            setReviewData(accumulated);
          } else if (evt.type === 'done' && accumulated) {
            accumulated = { ...accumulated, _loading: { metadata: false, priority: false, bullets: false, classification: false } };
            setReviewData(accumulated);
          }
        };

        const flushLines = () => {
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line) {
              try { handleEvent(JSON.parse(line)); } catch { /* ignore partial/garbled line */ }
            }
          }
        };

        while (true) {
          if (myReviewId !== reviewRequestIdRef.current) break; // superseded — stop reading
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          flushLines();
        }
        buffer += decoder.decode();
        flushLines();
        if (buffer.trim()) {
          try { handleEvent(JSON.parse(buffer.trim())); } catch { /* ignore */ }
        }

        if (!opened) {
          toast({ title: "Review Failed", description: 'Could not analyze link', variant: "destructive" });
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') return; // superseded/cancelled — stay silent
        toast({ title: "Review Error", description: err.message || 'Network error', variant: "destructive" });
      } finally {
        if (myReviewId === reviewRequestIdRef.current) setReviewLoading(false);
      }
    } else {
      const isNewTopic = selectedChatTopic?.id.startsWith('new:');
      sendMessageMutation.mutate({
        message: newMessage,
        topicId: isNewTopic ? undefined : selectedChatTopic?.id,
        newTopicName: isNewTopic ? selectedChatTopic?.name : undefined,
        isQuestionable: isQuestionableSource || undefined,
        isMataOsint: isMataOsintFlag || undefined,
      });
    }
  };

  const handleReviewSave = (saveData: ReviewSaveData) => {
    if (sendMessageMutation.isPending) return;
    const isNewTopic = selectedChatTopic?.id.startsWith('new:');
    sendMessageMutation.mutate({
      message: pendingReviewMessage,
      topicId: saveData.topicId || (isNewTopic ? undefined : selectedChatTopic?.id),
      newTopicName: saveData.newTopicName || (isNewTopic ? selectedChatTopic?.name : undefined),
      isQuestionable: undefined,
      isMataOsint: undefined,
      reviewData: saveData,
      idempotencyKey:
        reviewSaveIdempotencyRef.current ??
        (globalThis.crypto?.randomUUID?.() ?? `review-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    }, {
      onSuccess: () => {
        reviewSaveIdempotencyRef.current = null;
        setReviewDialogOpen(false);
        setReviewData(null);
        setPendingReviewMessage("");
      }
    });
  };

  const handleXPostReviewSave = async (saveData: XPostReviewSaveData) => {
    setXPostSaving(true);
    try {
      const resp = await fetch('/api/team/chat/submit-reviewed-x-post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          text: saveData.text,
          author: saveData.author,
          imageUrl: saveData.imageUrl,
          videoUrl: saveData.videoUrl,
          postedAt: saveData.postedAt,
          url: saveData.url,
          message: pendingXPostMessage,
        }),
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({ error: 'Save failed' }));
        toast({ title: "Save Failed", description: errData.error || 'Could not save X post', variant: "destructive" });
        return;
      }

      const isNewTopic = selectedChatTopic?.id.startsWith('new:');
      sendMessageMutation.mutate({
        message: pendingXPostMessage,
        topicId: isNewTopic ? undefined : selectedChatTopic?.id,
        newTopicName: isNewTopic ? selectedChatTopic?.name : undefined,
        isQuestionable: undefined,
        isMataOsint: true,
      }, {
        onSuccess: () => {
          setXPostReviewOpen(false);
          setXPostReviewData(null);
          setPendingXPostMessage("");
          queryClient.invalidateQueries({ queryKey: ['/api/flight-tracking/posts'] });
          toast({ title: "X Post Submitted", description: "The post has been added to the flight tracking feeds." });
        }
      });
    } catch (err: any) {
      toast({ title: "Save Error", description: err.message || 'Network error', variant: "destructive" });
    } finally {
      setXPostSaving(false);
    }
  };

  const handleImageUpload = async (file: File): Promise<string> => {
    const formData = new FormData();
    formData.append('image', file);
    
    const response = await fetch('/api/team/chat/upload-image', {
      method: 'POST',
      body: formData,
      credentials: 'include'
    });
    
    if (!response.ok) {
      throw new Error('Failed to upload image');
    }
    
    const data = await response.json();
    return data.url;
  };

  // Search functionality - combine all submissions from active and archived
  const allSubmissions = useMemo(() => [
    ...activeSubjects.flatMap(s => s.submissions.map(sub => ({ ...sub, subjectName: s.name }))),
    ...archivedSubjects.flatMap(s => s.submissions.map(sub => ({ ...sub, subjectName: s.name })))
  ], [activeSubjects, archivedSubjects]);

  const getRelevanceScore = (submission: typeof allSubmissions[0], query: string): number => {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    if (terms.length === 0) return 0;
    const headline = submission.headline.toLowerCase();
    const summary = submission.summary.toLowerCase();
    const subjectName = submission.subjectName.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (headline.includes(term)) score += 3;
      if (summary.includes(term)) score += 1;
      if (subjectName.includes(term)) score += 2;
    }
    return score;
  };

  const getTimeRangeCutoff = (): { start: Date | null; end: Date | null } => {
    const now = new Date();
    switch (timeRange) {
      case "1h": return { start: subHours(now, 1), end: null };
      case "6h": return { start: subHours(now, 6), end: null };
      case "24h": return { start: subHours(now, 24), end: null };
      case "week": return { start: subDays(now, 7), end: null };
      case "custom": return { 
        start: customDateRange.from ? startOfDay(customDateRange.from) : null, 
        end: customDateRange.to ? endOfDay(customDateRange.to) : null 
      };
      default: return { start: null, end: null };
    }
  };

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    return allSubmissions
      .map(sub => ({ ...sub, relevanceScore: getRelevanceScore(sub, searchQuery) }))
      .filter(sub => {
        if (sub.relevanceScore === 0) return false;
        const { start, end } = getTimeRangeCutoff();
        const subTime = new Date(sub.publishedAt || sub.createdAt);
        if (start && subTime < start) return false;
        if (end && subTime > end) return false;
        return true;
      })
      .sort((a, b) => {
        if (searchSortBy === "relevance") {
          return b.relevanceScore - a.relevanceScore;
        } else {
          const aTime = new Date(a.publishedAt || a.createdAt).getTime();
          const bTime = new Date(b.publishedAt || b.createdAt).getTime();
          return bTime - aTime;
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSubmissions, searchQuery, searchSortBy, timeRange, customDateRange]);

  if (isLoading || teamAccessLoading) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-sm text-muted-foreground">Checking access...</p>
        </div>
      </div>
    );
  }

  if (teamAccess?.reason === 'not_logged_in') {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-muted-foreground">Redirecting to login...</p>
        </div>
      </div>
    );
  }

  if (teamAccess?.reason === 'not_org_member') {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center max-w-md px-6">
          <div className="h-16 w-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4">
            <Shield className="h-8 w-8 text-destructive" />
          </div>
          <h2 className="text-xl font-semibold mb-2">Access Restricted</h2>
          <p className="text-muted-foreground mb-6">
            The Team page is only available to members of the Warfighter organization. 
            If you believe you should have access, please contact your administrator.
          </p>
          <div className="flex flex-col gap-2">
            <Button variant="outline" onClick={() => window.location.href = '/'}>
              Return to Dashboard
            </Button>
            <Button variant="ghost" onClick={() => logout()}>
              Sign Out
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!hasTeamAccess) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-muted-foreground">Checking access...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-background flex flex-col">
      <header className="border-b bg-card sticky top-0 z-50">
        {/* ── Mobile header (< md) ── */}
        <div className="flex md:hidden items-center justify-between px-4 py-2 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <img
              src={theme === "dark" ? mcopLogoWhite : mcopLogoBlack}
              alt="MCOP"
              className="h-10 w-auto shrink-0"
              data-testid="icon-logo"
            />
            <h1 className="text-base font-bold tracking-tight truncate" data-testid="text-team-title">
              Team Page
            </h1>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setMcopBotOpen(true)}
              className="flex items-center gap-1.5 hover-elevate rounded-full px-2 py-1 transition-colors"
              data-testid="button-mcopBot"
            >
              <img
                src={mcopBotIcon}
                alt="MCOP Bot"
                className="w-7 h-7 object-cover rounded-full"
              />
              <span className="text-xs font-medium text-primary hidden sm:inline">Ask MCOP Bot</span>
            </button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setMobileMenuOpen(true)}
              data-testid="button-mobile-menu"
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </Button>
          </div>
        </div>

        {/* ── Desktop header (md+) ── */}
        <div className="hidden md:block max-w-[1800px] mx-auto px-6 py-2">
          <div className="flex flex-col gap-2">
            {/* Tier 1: identity + global controls */}
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <img
                  src={theme === "dark" ? mcopLogoWhite : mcopLogoBlack}
                  alt="MCOP"
                  className="h-16 w-auto shrink-0"
                />
                <h1 className="text-xl font-bold tracking-tight">
                  Team Page
                </h1>
                <button
                  onClick={() => setMcopBotOpen(true)}
                  className="ml-2 flex items-center gap-2 hover-elevate rounded-full px-2 py-1 transition-colors"
                  data-testid="button-mcopBot"
                >
                  <img 
                    src={mcopBotIcon} 
                    alt="MCOP Bot" 
                    className="w-8 h-8 object-cover rounded-full"
                  />
                  <span className="text-sm font-medium text-primary">Ask MCOP Bot</span>
                </button>
              </div>

              <div className="flex items-center flex-wrap gap-3">
                {user && (
                  <div className="flex items-center gap-2">
                    {user.profileImageUrl && (
                      <img 
                        src={user.profileImageUrl} 
                        alt="Profile" 
                        className="w-8 h-8 rounded-full"
                        data-testid="img-profile"
                      />
                    )}
                    <span className="text-sm font-medium" data-testid="text-username">
                      {user.firstName || user.email || "User"}
                    </span>
                  </div>
                )}

                {fdStatus?.available && (() => {
                  const warning = fdStatus.percent >= fdStatus.threshold;
                  const caution = !warning && fdStatus.percent >= fdStatus.threshold * 0.75;
                  const tone = warning
                    ? "bg-destructive/10 text-destructive border-destructive/30"
                    : caution
                      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30"
                      : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";
                  return (
                    <div
                      className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium ${tone}`}
                      title={`Open file descriptors: ${fdStatus.current} of ${fdStatus.limit} (${fdStatus.percent}%). Warning threshold ${fdStatus.threshold}%.`}
                      data-testid="status-fd-capacity"
                    >
                      <Gauge className="w-3.5 h-3.5" />
                      <span data-testid="text-fd-usage">
                        FDs {fdStatus.current}/{fdStatus.limit}
                      </span>
                      <span className="opacity-80" data-testid="text-fd-percent">
                        ({fdStatus.percent}%)
                      </span>
                    </div>
                  );
                })()}

                {aiSettings && (
                  <div
                    className="flex items-center gap-1 rounded-md border p-0.5"
                    title={aiSettings.disabled
                      ? "AI integrations are disabled by operator configuration."
                      : "Choose which AI powers the whole MCOP. Auto (recommended) picks the healthy provider automatically and switches the moment one gets rate-limited. OpenRouter / Internal AI force one to run first, with the other as automatic backup."}
                    data-testid="control-ai-provider"
                  >
                    {aiSettings.disabled && (
                      <Badge variant="secondary" data-testid="badge-ai-disabled">AI off</Badge>
                    )}
                    <Button
                      size="sm"
                      variant={aiSettings.provider === 'auto' ? 'default' : 'ghost'}
                      onClick={() => aiSettings.provider !== 'auto' && setPendingAiProvider('auto')}
                      disabled={aiProviderMutation.isPending || aiSettings.disabled}
                      data-testid="button-ai-auto"
                    >
                      Auto
                    </Button>
                    <Button
                      size="sm"
                      variant={aiSettings.provider === 'openrouter' ? 'default' : 'ghost'}
                      onClick={() => aiSettings.provider !== 'openrouter' && setPendingAiProvider('openrouter')}
                      disabled={aiProviderMutation.isPending || aiSettings.disabled}
                      data-testid="button-ai-openrouter"
                    >
                      OpenRouter
                    </Button>
                    <Button
                      size="sm"
                      variant={aiSettings.provider === 'internal' ? 'default' : 'ghost'}
                      onClick={() => aiSettings.provider !== 'internal' && setPendingAiProvider('internal')}
                      disabled={aiProviderMutation.isPending || aiSettings.disabled}
                      data-testid="button-ai-internal"
                    >
                      Internal AI
                    </Button>
                  </div>
                )}

                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setQuarantineOpen(true)}
                  data-testid="button-open-quarantine"
                  title="Outlet registry oversight + quarantine review"
                >
                  <Shield className="w-4 h-4 mr-2" />
                  Source Oversight
                  {filterMetrics && filterMetrics.quarantined > 0 && (
                    <Badge variant="secondary" className="ml-2" data-testid="badge-quarantine-count">
                      {filterMetrics.quarantined}
                    </Badge>
                  )}
                </Button>

                <ThemeToggle />

                <ViewSwitcher
                  current="team"
                  hasCuratedAccess={!!curatedAccess?.hasCuratedAccess}
                  testIds={{
                    classic: "button-mcop-classic",
                    visual: "button-mcop-visual",
                    curated: "button-mcop-curated",
                    team: "button-mcop-team",
                  }}
                />

                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => logout()}
                  disabled={isLoggingOut}
                  data-testid="button-logout"
                >
                  <LogOut className="w-4 h-4 mr-2" />
                  {isLoggingOut ? "Logging out..." : "Logout"}
                </Button>
              </div>
            </div>

            {/* Tier 2: action toolbar grouped by function */}
            <div className="flex items-center flex-wrap gap-x-5 gap-y-2 border-t pt-2">
              {/* Briefing & content */}
              <div className="flex items-center flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setNewsScrubOpen(true)}
                  data-testid="button-news-scrub"
                >
                  <FileText className="w-4 h-4 mr-2" />
                  News Scrub
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setScrubUploadOpen(true)}
                  data-testid="button-upload-scrub"
                >
                  <Upload className="w-4 h-4 mr-2" />
                  Upload Daily News Scrub
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setBriefingCardOpen(true)}
                  data-testid="button-briefing-card"
                >
                  <ClipboardList className="w-4 h-4 mr-2" />
                  Briefing Card
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setQuoteDatabaseOpen(true)}
                  data-testid="button-quote-database"
                >
                  <Database className="w-4 h-4 mr-2" />
                  Quote Database
                </Button>
              </div>

              {/* Navigation */}
              <div className="flex items-center flex-wrap gap-2">
                <Link href="/stream-manager">
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="button-manage-stream"
                  >
                    <Monitor className="w-4 h-4 mr-2" />
                    Manage Stream
                  </Button>
                </Link>

                <Link href="/war">
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="button-war-dashboard"
                  >
                    <Shield className="w-4 h-4 mr-2" />
                    War
                  </Button>
                </Link>

                <Link href="/mcop/warfighter">
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="button-warfighter-feed"
                  >
                    <Shield className="w-4 h-4 mr-2" />
                    Warfighter
                  </Button>
                </Link>

                <Link href="/mcop/warfighter/admin">
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="button-warfighter-admin"
                  >
                    <Settings2 className="w-4 h-4 mr-2" />
                    Warfighter Admin
                  </Button>
                </Link>

                <Link href="/mcop/cyber">
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="button-cyber-feed"
                  >
                    <Shield className="w-4 h-4 mr-2" />
                    Cyber
                  </Button>
                </Link>

                <Link href="/mcop/cyber/admin">
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="button-cyber-admin"
                  >
                    <Settings2 className="w-4 h-4 mr-2" />
                    Cyber Admin
                  </Button>
                </Link>

                <Link href="/additional-mcops">
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="button-additional-mcops"
                  >
                    <Shield className="w-4 h-4 mr-2" />
                    Additional MCOPs
                  </Button>
                </Link>
              </div>

              {/* Content & team management */}
              <div className="flex items-center flex-wrap gap-2">
                <HeadlineManagementDialog />

                <ManagePOTUSPostsDialog />

                <ManageXPostsDialog />

                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setFtDialogOpen(true)}
                  data-testid="button-upload-flight-tracking"
                >
                  <MapPin className="w-4 h-4 mr-2" />
                  Upload Flight Tracking
                </Button>

                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setManageTeamOpen(true)}
                  data-testid="button-manage-team"
                >
                  <Users className="w-4 h-4 mr-2" />
                  Manage Team List
                </Button>
              </div>

              {/* Alerts */}
              <div className="flex items-center flex-wrap gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSmsAlertsOpen(true)}
                      data-testid="button-sms-alerts"
                    >
                      <Phone className="w-4 h-4 mr-2" />
                      SMS Alerts
                      <span
                        className={`ml-1.5 inline-block w-2 h-2 rounded-full shrink-0 ${
                          smsHealth?.color === 'red'
                            ? 'bg-red-500'
                            : smsHealth?.color === 'amber'
                            ? 'bg-amber-400'
                            : 'bg-green-500'
                        }`}
                        data-testid="status-sms-health"
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    {!smsHealth || smsHealth.color === 'green'
                      ? 'SMS alerts sending normally'
                      : smsHealth.color === 'amber'
                      ? `SMS degraded: ${smsHealth.reasons.join('; ')}`
                      : `SMS down: ${smsHealth.reasons.join('; ')}`}
                  </TooltipContent>
                </Tooltip>

                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRelayMonitorOpen(true)}
                  data-testid="button-relay-monitor"
                >
                  <Radio className="w-4 h-4 mr-2" />
                  Relay Monitor
                </Button>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* ── Mobile left-drawer ── */}
      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetContent side="left" className="w-[85vw] max-w-sm p-0 flex flex-col" data-testid="panel-mobile-drawer">
          <SheetHeader className="px-4 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="text-left">Menu</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
            {/* Identity */}
            {user && (
              <div className="flex items-center gap-2">
                {user.profileImageUrl && (
                  <img
                    src={user.profileImageUrl}
                    alt="Profile"
                    className="w-8 h-8 rounded-full"
                    data-testid="img-profile"
                  />
                )}
                <span className="text-sm font-medium" data-testid="text-username">
                  {user.firstName || user.email || "User"}
                </span>
              </div>
            )}

            {/* FD gauge */}
            {fdStatus?.available && (() => {
              const warning = fdStatus.percent >= fdStatus.threshold;
              const caution = !warning && fdStatus.percent >= fdStatus.threshold * 0.75;
              const tone = warning
                ? "bg-destructive/10 text-destructive border-destructive/30"
                : caution
                  ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30"
                  : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";
              return (
                <div
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium ${tone}`}
                  title={`Open file descriptors: ${fdStatus.current} of ${fdStatus.limit} (${fdStatus.percent}%). Warning threshold ${fdStatus.threshold}%.`}
                  data-testid="status-fd-capacity"
                >
                  <Gauge className="w-3.5 h-3.5" />
                  <span>FDs {fdStatus.current}/{fdStatus.limit}</span>
                  <span className="opacity-80">({fdStatus.percent}%)</span>
                </div>
              );
            })()}

            {/* AI provider switcher */}
            {aiSettings && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">AI Provider</p>
                {aiSettings.disabled && (
                  <Badge variant="secondary" data-testid="badge-ai-disabled-mobile">Disabled by operator</Badge>
                )}
                <div
                  className="flex items-center gap-1 rounded-md border p-0.5 w-fit"
                  title="Choose which AI powers the whole MCOP."
                  data-testid="control-ai-provider"
                >
                  <Button
                    size="sm"
                    variant={aiSettings.provider === 'auto' ? 'default' : 'ghost'}
                    onClick={() => { if (aiSettings.provider !== 'auto') setPendingAiProvider('auto'); setMobileMenuOpen(false); }}
                    disabled={aiProviderMutation.isPending || aiSettings.disabled}
                    data-testid="button-ai-auto"
                  >
                    Auto
                  </Button>
                  <Button
                    size="sm"
                    variant={aiSettings.provider === 'openrouter' ? 'default' : 'ghost'}
                    onClick={() => { if (aiSettings.provider !== 'openrouter') setPendingAiProvider('openrouter'); setMobileMenuOpen(false); }}
                    disabled={aiProviderMutation.isPending || aiSettings.disabled}
                    data-testid="button-ai-openrouter"
                  >
                    OpenRouter
                  </Button>
                  <Button
                    size="sm"
                    variant={aiSettings.provider === 'internal' ? 'default' : 'ghost'}
                    onClick={() => { if (aiSettings.provider !== 'internal') setPendingAiProvider('internal'); setMobileMenuOpen(false); }}
                    disabled={aiProviderMutation.isPending || aiSettings.disabled}
                    data-testid="button-ai-internal"
                  >
                    Internal AI
                  </Button>
                </div>
              </div>
            )}

            {/* Source Oversight */}
            <Button
              size="sm"
              variant="outline"
              className="w-full justify-start"
              onClick={() => { setQuarantineOpen(true); setMobileMenuOpen(false); }}
              data-testid="button-open-quarantine"
              title="Outlet registry oversight + quarantine review"
            >
              <Shield className="w-4 h-4 mr-2" />
              Source Oversight
              {filterMetrics && filterMetrics.quarantined > 0 && (
                <Badge variant="secondary" className="ml-auto" data-testid="badge-quarantine-count">
                  {filterMetrics.quarantined}
                </Badge>
              )}
            </Button>

            {/* Theme + View switcher */}
            <div className="flex items-center gap-2 flex-wrap">
              <div onClick={() => setMobileMenuOpen(false)}>
                <ThemeToggle />
              </div>
              <div onClick={() => setMobileMenuOpen(false)}>
                <ViewSwitcher
                  current="team"
                  hasCuratedAccess={!!curatedAccess?.hasCuratedAccess}
                  testIds={{
                    classic: "button-mcop-classic",
                    visual: "button-mcop-visual",
                    curated: "button-mcop-curated",
                    team: "button-mcop-team",
                  }}
                />
              </div>
            </div>

            {/* Logout */}
            <Button
              size="sm"
              variant="outline"
              className="w-full justify-start"
              onClick={() => { logout(); setMobileMenuOpen(false); }}
              disabled={isLoggingOut}
              data-testid="button-logout"
            >
              <LogOut className="w-4 h-4 mr-2" />
              {isLoggingOut ? "Logging out..." : "Logout"}
            </Button>

            <div className="border-t pt-4 space-y-2">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Briefing &amp; Content</p>
              <Button
                size="sm"
                variant="outline"
                className="w-full justify-start"
                onClick={() => { setNewsScrubOpen(true); setMobileMenuOpen(false); }}
                data-testid="button-news-scrub"
              >
                <FileText className="w-4 h-4 mr-2" />
                News Scrub
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="w-full justify-start"
                onClick={() => { setScrubUploadOpen(true); setMobileMenuOpen(false); }}
                data-testid="button-upload-scrub"
              >
                <Upload className="w-4 h-4 mr-2" />
                Upload Daily News Scrub
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="w-full justify-start"
                onClick={() => { setBriefingCardOpen(true); setMobileMenuOpen(false); }}
                data-testid="button-briefing-card"
              >
                <ClipboardList className="w-4 h-4 mr-2" />
                Briefing Card
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="w-full justify-start"
                onClick={() => { setQuoteDatabaseOpen(true); setMobileMenuOpen(false); }}
                data-testid="button-quote-database"
              >
                <Database className="w-4 h-4 mr-2" />
                Quote Database
              </Button>
            </div>

            <div className="border-t pt-4 space-y-2">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Navigation</p>
              <Link href="/stream-manager" onClick={() => setMobileMenuOpen(false)}>
                <Button size="sm" variant="outline" className="w-full justify-start" data-testid="button-manage-stream">
                  <Monitor className="w-4 h-4 mr-2" />
                  Manage Stream
                </Button>
              </Link>
              <Link href="/war" onClick={() => setMobileMenuOpen(false)}>
                <Button size="sm" variant="outline" className="w-full justify-start" data-testid="button-war-dashboard">
                  <Shield className="w-4 h-4 mr-2" />
                  War
                </Button>
              </Link>
              <Link href="/mcop/warfighter" onClick={() => setMobileMenuOpen(false)}>
                <Button size="sm" variant="outline" className="w-full justify-start" data-testid="button-warfighter-feed">
                  <Shield className="w-4 h-4 mr-2" />
                  Warfighter
                </Button>
              </Link>
              <Link href="/mcop/warfighter/admin" onClick={() => setMobileMenuOpen(false)}>
                <Button size="sm" variant="outline" className="w-full justify-start" data-testid="button-warfighter-admin">
                  <Settings2 className="w-4 h-4 mr-2" />
                  Warfighter Admin
                </Button>
              </Link>
              <Link href="/mcop/cyber" onClick={() => setMobileMenuOpen(false)}>
                <Button size="sm" variant="outline" className="w-full justify-start" data-testid="button-cyber-feed">
                  <Shield className="w-4 h-4 mr-2" />
                  Cyber
                </Button>
              </Link>
              <Link href="/mcop/cyber/admin" onClick={() => setMobileMenuOpen(false)}>
                <Button size="sm" variant="outline" className="w-full justify-start" data-testid="button-cyber-admin">
                  <Settings2 className="w-4 h-4 mr-2" />
                  Cyber Admin
                </Button>
              </Link>
              <Link href="/additional-mcops" onClick={() => setMobileMenuOpen(false)}>
                <Button size="sm" variant="outline" className="w-full justify-start" data-testid="button-additional-mcops">
                  <Shield className="w-4 h-4 mr-2" />
                  Additional MCOPs
                </Button>
              </Link>
            </div>

            <div className="border-t pt-4 space-y-2">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Content &amp; Admin</p>
              <div onClick={() => setMobileMenuOpen(false)}>
                <HeadlineManagementDialog />
              </div>
              <div onClick={() => setMobileMenuOpen(false)}>
                <ManagePOTUSPostsDialog />
              </div>
              <div onClick={() => setMobileMenuOpen(false)}>
                <ManageXPostsDialog />
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="w-full justify-start"
                onClick={() => { setFtDialogOpen(true); setMobileMenuOpen(false); }}
                data-testid="button-upload-flight-tracking"
              >
                <MapPin className="w-4 h-4 mr-2" />
                Upload Flight Tracking
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="w-full justify-start"
                onClick={() => { setManageTeamOpen(true); setMobileMenuOpen(false); }}
                data-testid="button-manage-team"
              >
                <Users className="w-4 h-4 mr-2" />
                Manage Team List
              </Button>
            </div>

            <div className="border-t pt-4 space-y-2">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Alerts &amp; Monitoring</p>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full justify-start"
                    onClick={() => { setSmsAlertsOpen(true); setMobileMenuOpen(false); }}
                    data-testid="button-sms-alerts"
                  >
                    <Phone className="w-4 h-4 mr-2" />
                    SMS Alerts
                    <span
                      className={`ml-1.5 inline-block w-2 h-2 rounded-full shrink-0 ${
                        smsHealth?.color === 'red'
                          ? 'bg-red-500'
                          : smsHealth?.color === 'amber'
                          ? 'bg-amber-400'
                          : 'bg-green-500'
                      }`}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs">
                  {!smsHealth || smsHealth.color === 'green'
                    ? 'SMS alerts sending normally'
                    : smsHealth.color === 'amber'
                    ? `SMS degraded: ${smsHealth.reasons.join('; ')}`
                    : `SMS down: ${smsHealth.reasons.join('; ')}`}
                </TooltipContent>
              </Tooltip>
              <Button
                size="sm"
                variant="ghost"
                className="w-full justify-start"
                onClick={() => { setRelayMonitorOpen(true); setMobileMenuOpen(false); }}
                data-testid="button-relay-monitor"
              >
                <Radio className="w-4 h-4 mr-2" />
                Relay Monitor
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
      
      {/* Desktop: resizable split grid. Mobile: vertically stacked panes with page scroll. */}
      <main className="flex-1 md:overflow-hidden overflow-auto md:grid flex flex-col" ref={splitContainerRef} style={{ gridTemplateColumns: `${splitRatio}fr 6px ${100 - splitRatio}fr` }}>
        <div className="p-4 flex flex-col md:h-full md:overflow-hidden md:min-h-0 min-h-[65vh] md:min-h-0">
          <Card className="flex-1 flex flex-col overflow-hidden h-full">
            <CardHeader className="py-3 border-b space-y-2">
              <div className="flex flex-row items-center justify-between gap-2">
                <CardTitle className="text-lg" data-testid="text-chat-title">Team Chat</CardTitle>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    size="sm"
                    variant="outline"
                    className={`toggle-elevate ${reviewEnabled ? 'toggle-elevated' : ''}`}
                    onClick={handleToggleReview}
                    data-testid="button-review-toggle"
                  >
                    <ClipboardList className="h-3.5 w-3.5 mr-1" />
                    Review {reviewEnabled ? "On" : "Off"}
                  </Button>
                  <Button
                    variant={hideBots ? "default" : "outline"}
                    size="sm"
                    onClick={() => setHideBots(!hideBots)}
                    data-testid="button-hide-bots"
                  >
                    {hideBots ? "Show Bots" : "Hide Bots"}
                  </Button>
                </div>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search chat..."
                  value={chatSearchQuery}
                  onChange={(e) => setChatSearchQuery(e.target.value)}
                  className="pl-9 h-8 text-sm"
                  data-testid="input-chat-search"
                />
                {chatSearchQuery && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
                    onClick={() => setChatSearchQuery("")}
                    data-testid="button-chat-search-clear"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col p-0 overflow-hidden">
              <ScrollArea className="flex-1 p-4" ref={scrollAreaRef}>
                {messagesLoading ? (
                  <div className="flex items-center justify-center h-full">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                  </div>
                ) : messages.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-muted-foreground">
                    <p>No messages yet. Start the conversation!</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {messages
                      .filter((msg) => !hideBots || !msg.userName.endsWith('Bot'))
                      .filter((msg) => !chatSearchQuery || msg.message.toLowerCase().includes(chatSearchQuery.toLowerCase()) || msg.userName.toLowerCase().includes(chatSearchQuery.toLowerCase()))
                      .map((msg) => (
                      <div 
                        key={msg.id} 
                        className="flex gap-3"
                        data-testid={`chat-message-${msg.id}`}
                      >
                        <Avatar className="h-8 w-8 flex-shrink-0">
                          <AvatarImage src={msg.userProfileImage || undefined} />
                          <AvatarFallback>
                            {msg.userName.charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="font-semibold text-sm" data-testid={`chat-username-${msg.id}`}>
                              {msg.userName}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(msg.createdAt), 'MMM d, h:mm a')}
                            </span>
                            <span className="flex items-center gap-0.5 ml-auto">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6"
                                onClick={() => handleCopyChatMessage(msg)}
                                title="Copy message"
                                data-testid={`button-copy-msg-${msg.id}`}
                              >
                                <Copy className="h-3 w-3" />
                              </Button>
                              {user && msg.userId === user.id && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-6 w-6 text-destructive"
                                  onClick={() => deleteChatMessageMutation.mutate(msg.id)}
                                  title="Delete message"
                                  data-testid={`button-delete-msg-${msg.id}`}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              )}
                            </span>
                          </div>
                          {!msg.userName.endsWith('Bot') ? (
                            <div 
                              className="text-sm mt-1 break-words prose prose-sm dark:prose-invert max-w-none bg-muted/60 dark:bg-muted/30 border border-border/50 rounded-md px-3 py-2 [&_img]:max-w-full [&_img]:h-auto [&_img]:rounded-md [&_img]:my-2 [&_a]:text-blue-600 [&_a]:dark:text-blue-400 [&_a]:underline [&_a]:hover:text-blue-800 [&_a]:dark:hover:text-blue-300" 
                              data-testid={`chat-text-${msg.id}`}
                              dangerouslySetInnerHTML={{ __html: linkifyHtml(msg.message) }}
                            />
                          ) : (
                            <div 
                              className="text-sm mt-1 break-words prose prose-sm dark:prose-invert max-w-none [&_img]:max-w-full [&_img]:h-auto [&_img]:rounded-md [&_img]:my-2 [&_a]:text-blue-600 [&_a]:dark:text-blue-400 [&_a]:underline [&_a]:hover:text-blue-800 [&_a]:dark:hover:text-blue-300" 
                              data-testid={`chat-text-${msg.id}`}
                              dangerouslySetInnerHTML={{ __html: linkifyHtml(msg.message) }}
                            />
                          )}
                        </div>
                      </div>
                    ))}
                    <div ref={messagesEndRef} />
                  </div>
                )}
              </ScrollArea>
              
              <div className="p-4 border-t">
                {(selectedChatTopic || isQuestionableSource || isMataOsintFlag) && (
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    {selectedChatTopic && (
                    <div className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold bg-secondary text-secondary-foreground">
                      <FolderInput className="h-3 w-3" />
                      Topic: {selectedChatTopic.name}
                      <span
                        role="button"
                        tabIndex={0}
                        className="ml-1 cursor-pointer rounded-sm hover:bg-muted p-0.5"
                        onClick={() => setSelectedChatTopic(null)}
                        onKeyDown={(e) => { if (e.key === 'Enter') setSelectedChatTopic(null); }}
                        data-testid="button-clear-chat-topic"
                      >
                        <X className="h-3 w-3" />
                      </span>
                    </div>
                    )}
                    {isQuestionableSource && (
                    <div className="inline-flex items-center gap-1 rounded-md border border-orange-300 dark:border-orange-600 px-2 py-0.5 text-xs font-semibold bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400">
                      <HelpCircle className="h-3 w-3" />
                      Questionable Source
                      <span
                        role="button"
                        tabIndex={0}
                        className="ml-1 cursor-pointer rounded-sm hover:bg-orange-200 dark:hover:bg-orange-800 p-0.5"
                        onClick={() => setIsQuestionableSource(false)}
                        onKeyDown={(e) => { if (e.key === 'Enter') setIsQuestionableSource(false); }}
                        data-testid="button-clear-questionable"
                      >
                        <X className="h-3 w-3" />
                      </span>
                    </div>
                    )}
                    {isMataOsintFlag && (
                    <div className="inline-flex items-center gap-1 rounded-md border border-emerald-300 dark:border-emerald-600 px-2 py-0.5 text-xs font-semibold bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
                      <Plane className="h-3 w-3" />
                      MATA / OSINT
                      <span
                        role="button"
                        tabIndex={0}
                        className="ml-1 cursor-pointer rounded-sm hover:bg-emerald-200 dark:hover:bg-emerald-800 p-0.5"
                        onClick={() => setIsMataOsintFlag(false)}
                        onKeyDown={(e) => { if (e.key === 'Enter') setIsMataOsintFlag(false); }}
                        data-testid="button-clear-mata-osint"
                      >
                        <X className="h-3 w-3" />
                      </span>
                    </div>
                    )}
                  </div>
                )}
                {reviewLoading && (
                  <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Analyzing link for review...
                  </div>
                )}
                {xPostReviewLoading && (
                  <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Scraping X post for review...
                  </div>
                )}
                <Suspense fallback={<div className="min-h-[92px] rounded-md border border-input bg-background" />}>
                <RichTextEditor
                  value={newMessage}
                  onChange={setNewMessage}
                  onSubmit={handleSendMessage}
                  placeholder="Share a story or post..."
                  disabled={sendMessageMutation.isPending || reviewLoading || xPostReviewLoading}
                  onImageUpload={handleImageUpload}
                  sendAdornment={
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      title="Use user-supplied Info"
                      aria-label="Use user-supplied Info"
                      aria-pressed={useUserSuppliedInfo}
                      onClick={() => setUseUserSuppliedInfo(v => !v)}
                      className={`toggle-elevate ${useUserSuppliedInfo ? 'toggle-elevated' : ''}`}
                      data-testid="button-use-user-info"
                    >
                      <Quote className="h-4 w-4" />
                    </Button>
                  }
                />
                </Suspense>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <Popover open={chatTopicPopoverOpen} onOpenChange={setChatTopicPopoverOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        size="sm"
                        variant={selectedChatTopic ? "default" : "outline"}
                        data-testid="button-chat-topic"
                      >
                        <FolderInput className="h-3.5 w-3.5 mr-1" />
                        Topic
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-56 p-3" align="start">
                      <div className="space-y-3">
                        <Label className="text-xs font-medium">Assign to topic</Label>
                        <Select
                          value=""
                          onValueChange={(val) => {
                            const topic = allTopics.find(t => t.id === val);
                            if (topic) {
                              setSelectedChatTopic({ id: topic.id, name: topic.name });
                              setChatTopicPopoverOpen(false);
                            }
                          }}
                        >
                          <SelectTrigger className="text-sm" data-testid="select-chat-topic">
                            <SelectValue placeholder="Select topic..." />
                          </SelectTrigger>
                          <SelectContent>
                            <TopicSelectItems
                              topics={allTopics}
                            />
                          </SelectContent>
                        </Select>
                        <div className="border-t pt-2">
                          <Label className="text-xs text-muted-foreground">Or create new topic</Label>
                          <div className="flex gap-2 mt-1">
                            <Input
                              placeholder="New topic name"
                              value={newChatTopicInput}
                              onChange={(e) => setNewChatTopicInput(e.target.value)}
                              className="text-sm"
                              data-testid="input-new-chat-topic"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && newChatTopicInput.trim()) {
                                  e.preventDefault();
                                  setSelectedChatTopic({ id: `new:${newChatTopicInput.trim()}`, name: newChatTopicInput.trim() });
                                  setNewChatTopicInput("");
                                  setChatTopicPopoverOpen(false);
                                }
                              }}
                            />
                            <Button
                              size="sm"
                              disabled={!newChatTopicInput.trim()}
                              onClick={() => {
                                if (newChatTopicInput.trim()) {
                                  setSelectedChatTopic({ id: `new:${newChatTopicInput.trim()}`, name: newChatTopicInput.trim() });
                                  setNewChatTopicInput("");
                                  setChatTopicPopoverOpen(false);
                                }
                              }}
                              data-testid="button-create-chat-topic"
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                  <Button
                    size="sm"
                    variant={isQuestionableSource ? "default" : "outline"}
                    className={isQuestionableSource ? "bg-orange-600 text-white border-orange-700" : ""}
                    onClick={() => setIsQuestionableSource(!isQuestionableSource)}
                    data-testid="button-questionable-source"
                  >
                    <HelpCircle className="h-3.5 w-3.5 mr-1" />
                    ?
                  </Button>
                  <Button
                    size="sm"
                    variant={isMataOsintFlag ? "default" : "outline"}
                    className={isMataOsintFlag ? "bg-emerald-600 text-white border-emerald-700" : ""}
                    onClick={() => setIsMataOsintFlag(!isMataOsintFlag)}
                    data-testid="button-mata-osint-toggle"
                  >
                    <Plane className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
        
        <div
          className="cursor-col-resize relative hidden md:block"
          onMouseDown={handleSplitMouseDown}
          data-testid="panel-split-handle"
        >
          <div className="absolute inset-y-0 -left-1 -right-1 z-10" />
          <div className="h-full w-px mx-auto bg-border" />
        </div>
        <div className="p-4 flex flex-col md:h-full gap-4 md:overflow-hidden min-w-0 min-h-[50vh] md:min-h-0">
          <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search topics..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && searchQuery.trim()) {
                      setSearchOpen(true);
                    }
                  }}
                  className="pl-9"
                  data-testid="input-search"
                />
              </div>
              <Button 
                onClick={() => searchQuery.trim() && setSearchOpen(true)}
                disabled={!searchQuery.trim()}
                data-testid="button-search"
              >
                <Search className="h-4 w-4" />
              </Button>
            </div>
            <DialogContent className="max-w-2xl h-[80vh] flex flex-col">
              <DialogHeader className="flex-shrink-0">
                <DialogTitle className="flex items-center justify-between gap-4">
                  <span>Search Results for "{searchQuery}" ({searchResults.length} found)</span>
                  <Select value={searchSortBy} onValueChange={(v) => setSearchSortBy(v as "date" | "relevance")}>
                    <SelectTrigger className="w-32" data-testid="select-sort">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="relevance">Relevance</SelectItem>
                      <SelectItem value="date">Date</SelectItem>
                    </SelectContent>
                  </Select>
                </DialogTitle>
              </DialogHeader>
              
              <Collapsible open={showSearchOptions} onOpenChange={setShowSearchOptions} className="flex-shrink-0 border rounded-md p-2">
                <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground w-full" data-testid="button-more-search-options">
                  <Settings2 className="h-4 w-4" />
                  More search options
                  {showSearchOptions ? <ChevronDown className="h-4 w-4 ml-auto" /> : <ChevronRight className="h-4 w-4 ml-auto" />}
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-3 space-y-3">
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Time Range</p>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { value: "all", label: "All time" },
                        { value: "1h", label: "Last hour" },
                        { value: "6h", label: "Last 6 hours" },
                        { value: "24h", label: "Last 24 hours" },
                        { value: "week", label: "Last week" },
                        { value: "custom", label: "Date range" },
                      ].map((option) => (
                        <Button
                          key={option.value}
                          size="sm"
                          variant={timeRange === option.value ? "default" : "outline"}
                          onClick={() => setTimeRange(option.value as typeof timeRange)}
                          data-testid={`button-time-${option.value}`}
                        >
                          {option.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                  
                  {timeRange === "custom" && (
                    <div className="flex items-center gap-2">
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button variant="outline" size="sm" className="justify-start text-left font-normal" data-testid="button-date-from">
                            <CalendarIcon className="mr-2 h-4 w-4" />
                            {customDateRange.from ? format(customDateRange.from, "MMM d, yyyy") : "From date"}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <Calendar
                            mode="single"
                            selected={customDateRange.from}
                            onSelect={(date) => setCustomDateRange(prev => ({ ...prev, from: date }))}
                            initialFocus
                          />
                        </PopoverContent>
                      </Popover>
                      <span className="text-muted-foreground">to</span>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button variant="outline" size="sm" className="justify-start text-left font-normal" data-testid="button-date-to">
                            <CalendarIcon className="mr-2 h-4 w-4" />
                            {customDateRange.to ? format(customDateRange.to, "MMM d, yyyy") : "To date"}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <Calendar
                            mode="single"
                            selected={customDateRange.to}
                            onSelect={(date) => setCustomDateRange(prev => ({ ...prev, to: date }))}
                            initialFocus
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                  )}
                </CollapsibleContent>
              </Collapsible>
              
              <div className="flex-1 overflow-y-auto pr-2">
                <div className="space-y-3">
                  {searchResults.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                      <Search className="h-12 w-12 mb-3 opacity-50" />
                      <p className="text-sm">No results found</p>
                    </div>
                  ) : (
                    searchResults.map((submission) => (
                      <Card key={`search-${submission.id}`} className="p-3">
                        <div className="flex items-start gap-2">
                          <Checkbox
                            checked={submission.isRead}
                            onCheckedChange={() => toggleReadMutation.mutate(submission.id)}
                            className="mt-0.5 flex-shrink-0"
                            data-testid={`search-checkbox-read-${submission.id}`}
                          />
                          {submission.sourceType === 'social_media' ? (
                            <Share2 className="h-4 w-4 text-blue-500 flex-shrink-0 mt-0.5" />
                          ) : (
                            <Newspaper className="h-4 w-4 text-orange-500 flex-shrink-0 mt-0.5" />
                          )}
                          <div className="flex-1 min-w-0">
                            <a 
                              href={submission.sourceUrl} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className={`font-medium text-sm hover:text-primary inline-flex items-center gap-1 leading-tight ${submission.isRead ? 'text-muted-foreground' : ''}`}
                              data-testid={`search-submission-link-${submission.id}`}
                            >
                              {submission.headline}
                              <ExternalLink className="h-3 w-3 flex-shrink-0" />
                            </a>
                            <div className="flex items-center gap-2 mt-1">
                              <Badge variant="outline" className="text-xs">
                                {submission.subjectName}
                              </Badge>
                              <span className="text-xs text-muted-foreground">
                                {submission.sourceName || 'Unknown Source'} • {format(new Date(submission.publishedAt || submission.createdAt), 'MMM d, h:mm a')}
                              </span>
                            </div>
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                              {submission.summary}
                            </p>
                          </div>
                        </div>
                      </Card>
                    ))
                  )}
                </div>
              </div>
            </DialogContent>
          </Dialog>
          
          {/* Priority / BOLO pointer (Task #1094) — management moved to Source
              Oversight → Priority / BOLO tab. Auto-match tagging toggle stays
              here (it affects Team-page submission tagging). */}
          <Card className="border-purple-500/50 bg-purple-500/5 mb-3 flex-shrink-0">
            <div className="flex items-center justify-between gap-2 p-3 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <Radar className="h-4 w-4 text-purple-600 dark:text-purple-400 flex-shrink-0" />
                <span className="font-medium text-sm text-purple-600 dark:text-purple-400">
                  IE Priorities / BOLO
                </span>
                {((joePriorityData?.joePriorities?.length || 0) + (joePriorityData?.boloItems?.length || 0)) > 0 && (
                  <Badge variant="secondary" className="text-xs" data-testid="badge-watch-topic-count">
                    {(joePriorityData?.joePriorities?.length || 0) + (joePriorityData?.boloItems?.length || 0)}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
                <div className="flex items-center gap-1.5" title="Auto-match new submissions to active priorities/BOLO topics">
                  <Switch
                    checked={joePriorityMatchingEnabled}
                    onCheckedChange={(checked) => toggleJoePriorityMatchingMutation.mutate(checked)}
                    disabled={toggleJoePriorityMatchingMutation.isPending}
                    data-testid="switch-joe-priority-matching"
                  />
                  <span className="text-xs text-muted-foreground hidden sm:inline">Auto-match</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setOversightInitialTab("watchtopics"); setQuarantineOpen(true); }}
                  data-testid="button-manage-watch-topics"
                >
                  Manage
                  <ExternalLink className="h-3.5 w-3.5 ml-1.5" />
                </Button>
              </div>
            </div>
            <div className="px-3 pb-2 -mt-1 text-[11px] text-muted-foreground">
              Watch topics are now managed in Source Oversight → Priority / BOLO.
            </div>
          </Card>

          <Card className="flex-1 flex flex-col overflow-hidden min-h-0">
            <CardHeader className="py-3 border-b flex-shrink-0">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-lg flex items-center gap-2" data-testid="text-active-title">
                  <FolderOpen className="h-5 w-5" />
                  Content Coverage
                </CardTitle>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Dialog open={botControlOpen} onOpenChange={setBotControlOpen}>
                    <DialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid="button-open-bot-control"
                      >
                        <Bot className="h-3 w-3 mr-1" />
                        News Bots
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-md">
                      <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                          <Bot className="h-5 w-5" />
                          News Bot Control
                        </DialogTitle>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <p className="text-xs text-muted-foreground mb-3">
                            These bots scrape news sources and post relevant articles to Team Chat for review.
                          </p>
                          <div className="space-y-1">
                            {(botControlData?.bots || []).map(bot => (
                              <div
                                key={bot.id}
                                className="flex items-center justify-between gap-3 py-2 px-3 rounded-md border"
                                data-testid={`bot-row-${bot.id}`}
                              >
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-sm font-medium" data-testid={`bot-name-${bot.id}`}>{bot.name}</span>
                                    <Badge variant="secondary" className="text-[10px]">{bot.schedule}</Badge>
                                  </div>
                                  <p className="text-xs text-muted-foreground truncate">{bot.description}</p>
                                </div>
                                <Switch
                                  checked={bot.enabled}
                                  onCheckedChange={(checked) => toggleBotMutation.mutate({ botId: bot.id, enabled: checked })}
                                  disabled={toggleBotMutation.isPending}
                                  data-testid={`bot-toggle-${bot.id}`}
                                />
                              </div>
                            ))}
                          </div>
                        </div>

                      </div>
                    </DialogContent>
                  </Dialog>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => toggleTopicClusteringMutation.mutate(!topicClusteringEnabled)}
                    disabled={toggleTopicClusteringMutation.isPending}
                    className={`toggle-elevate ${topicClusteringEnabled ? 'toggle-elevated' : ''}`}
                    data-testid="button-toggle-topic-clustering"
                  >
                    {toggleTopicClusteringMutation.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : (
                      <Layers className="h-3 w-3 mr-1" />
                    )}
                    Clustering {topicClusteringEnabled ? 'On' : 'Off'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setGroupByTopic(v => !v)}
                    className={`toggle-elevate ${groupByTopic ? 'toggle-elevated' : ''}`}
                    data-testid="button-toggle-group-by-topic"
                  >
                    <FolderOpen className="h-3 w-3 mr-1" />
                    By Topic {groupByTopic ? 'On' : 'Off'}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex-1 p-0 overflow-hidden">
              <ScrollArea className="h-full">
                <div className="p-4 space-y-3">
                  {curatedAccess?.hasCuratedAccess && (
                    <Collapsible open={curatedSectionOpen} onOpenChange={setCuratedSectionOpen}>
                      <Card className="overflow-hidden border-indigo-500/50 bg-indigo-500/5">
                        <div className="flex items-center justify-between gap-1 p-3 hover-elevate">
                          <CollapsibleTrigger className="flex-1 min-w-0" data-testid="curated-only-trigger">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                {curatedSectionOpen ? (
                                  <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                                ) : (
                                  <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                                )}
                                <Star className="h-4 w-4 text-indigo-600 dark:text-indigo-400 flex-shrink-0" />
                                <span className="font-medium text-sm truncate text-indigo-600 dark:text-indigo-400">CURATED ONLY</span>
                              </div>
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground flex-shrink-0">
                                {curatedStories.length > 0 && (
                                  <Badge variant="secondary" className="text-xs">{curatedStories.length} stories</Badge>
                                )}
                              </div>
                            </div>
                          </CollapsibleTrigger>
                        </div>
                        <CollapsibleContent>
                          <div className="border-t px-3 pb-3 space-y-3">
                            <p className="text-xs text-muted-foreground pt-2">
                              Read-only view of the curated Top Stories lane. This content is isolated and never enters the MCOP feeds.
                            </p>
                            {curatedStories.slice(0, 20).map((story) => {
                              const topicLabel = primaryTopicShortLabel(story.primaryTopic) || story.category;
                              return (
                                <div key={story.id} className="pt-3 border-b last:border-b-0 pb-3" data-testid={`curated-story-${story.id}`}>
                                  <div className="flex items-start gap-2">
                                    <Star className="h-4 w-4 text-indigo-500 flex-shrink-0 mt-0.5" />
                                    <div className="flex-1 min-w-0">
                                      <a
                                        href={story.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="font-medium text-sm hover:text-primary inline-flex items-center gap-1 leading-tight"
                                        data-testid={`curated-story-link-${story.id}`}
                                      >
                                        {story.displayTitle || story.title}
                                        <ExternalLink className="h-3 w-3 flex-shrink-0" />
                                      </a>
                                      <div className="flex items-center justify-between gap-2 mt-2">
                                        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                                          <span>{story.source}</span>
                                          {story.sourceCount > 1 && (
                                            <>
                                              <span>•</span>
                                              <span>{story.sourceCount} sources</span>
                                            </>
                                          )}
                                          {(story.articlePublishedAt || story.scrapedAt) && (
                                            <>
                                              <span>•</span>
                                              <span>{format(new Date(story.articlePublishedAt || story.scrapedAt), 'MMM d, h:mm a')}</span>
                                            </>
                                          )}
                                        </div>
                                        {topicLabel && (
                                          <Badge variant="outline" className="text-[10px] flex-shrink-0">{topicLabel}</Badge>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                            {curatedStories.length === 0 && (
                              <p className="py-2 text-center text-muted-foreground text-sm">No curated stories right now</p>
                            )}
                            <Link href="/curated" className="inline-flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400 hover:underline" data-testid="link-open-curated">
                              Open full Curated view
                              <ExternalLink className="h-3 w-3" />
                            </Link>
                          </div>
                        </CollapsibleContent>
                      </Card>
                    </Collapsible>
                  )}
                  {subjectsLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                    </div>
                  ) : activeSubjects.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                      <Clock className="h-12 w-12 mb-3 opacity-50" />
                      <p className="text-sm">No active topics</p>
                      <p className="text-xs mt-1">Share a link in the chat to get started</p>
                    </div>
                  ) : (
                    activeRenderEntries.map((entry) => {
                      if (entry.kind === 'header') {
                        return (
                          <div key={`cat-${entry.id}`} className="flex items-center gap-2 pt-2 pb-0.5 first:pt-0" data-testid={`topic-group-${entry.id}`}>
                            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground truncate">{entry.label}</span>
                            <Badge variant="secondary" className="text-[10px] flex-shrink-0">{entry.count}</Badge>
                            <div className="flex-1 h-px bg-border" />
                          </div>
                        );
                      }
                      const subject = entry.subject;
                      return (
                      <Collapsible
                        key={`active-${subject.id}`}
                        open={expandedSubjects.has(`active-${subject.id}`)}
                        onOpenChange={() => toggleSubject(`active-${subject.id}`)}
                      >
                        <Card className={`overflow-hidden ${subject.name === 'FLASH: TOP STORIES' ? 'border-amber-500/50 bg-amber-500/5' : subject.name === 'MOST RECENT' ? 'border-emerald-500/50 bg-emerald-500/5' : subject.name === 'CJCS MENTIONS' ? 'border-blue-500/50 bg-blue-500/5' : subject.name === 'MATA / OSINT SOCIAL MEDIA' ? 'border-teal-500/50 bg-teal-500/5' : ''}`}>
                          <div className="flex items-center justify-between gap-1 p-3 hover-elevate">
                            <CollapsibleTrigger className="flex-1 min-w-0" data-testid={`active-subject-trigger-${subject.id}`}>
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                  {expandedSubjects.has(`active-${subject.id}`) ? (
                                    <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                                  )}
                                  <span className={`font-medium text-sm truncate ${subject.name === 'FLASH: TOP STORIES' ? 'text-amber-600 dark:text-amber-400' : subject.name === 'MOST RECENT' ? 'text-emerald-600 dark:text-emerald-400' : subject.name === 'CJCS MENTIONS' ? 'text-blue-600 dark:text-blue-400' : subject.name === 'MATA / OSINT SOCIAL MEDIA' ? 'text-teal-600 dark:text-teal-400' : ''}`}>{subject.name}</span>
                                </div>
                                <div className="flex items-center gap-1.5 text-xs text-muted-foreground flex-shrink-0">
                                  {(subject.unreadNewsCount > 0 || subject.unreadSocialCount > 0) ? (
                                    <>
                                      {subject.unreadNewsCount > 0 && (
                                        <Badge variant="secondary" className="text-xs">
                                          {subject.unreadNewsCount} News
                                        </Badge>
                                      )}
                                      {subject.unreadSocialCount > 0 && (
                                        <Badge variant="outline" className="text-xs">
                                          {subject.unreadSocialCount} Social
                                        </Badge>
                                      )}
                                    </>
                                  ) : subject.submissions.length === 0 ? (
                                    <span className="text-muted-foreground/60">No items</span>
                                  ) : (
                                    <span className="text-muted-foreground/60">All read</span>
                                  )}
                                </div>
                              </div>
                            </CollapsibleTrigger>
                            {subject.name !== 'FLASH: TOP STORIES' && subject.name !== 'MOST RECENT' && subject.name !== 'CJCS MENTIONS' && subject.name !== 'MATA / OSINT SOCIAL MEDIA' && (
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setTopicToDelete(subject);
                                  setDeleteTopicConfirmOpen(true);
                                }}
                                data-testid={`button-delete-topic-${subject.id}`}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                          <CollapsibleContent>
                            <div className="border-t px-3 pb-3 space-y-3">
                              {subject.submissions.length === 0 && subject.name === 'FLASH: TOP STORIES' && (
                                <div className="py-4 text-center text-muted-foreground text-sm">
                                  <p>No high-priority stories in the last 12 hours</p>
                                  <p className="text-xs mt-1">Items scoring 75+ will appear here</p>
                                </div>
                              )}
                              {subject.submissions.length === 0 && subject.name === 'MOST RECENT' && (
                                <div className="py-4 text-center text-muted-foreground text-sm">
                                  <p>No stories in the past 3 hours</p>
                                  <p className="text-xs mt-1">Recent news and social media posts will appear here</p>
                                </div>
                              )}
                              {subject.submissions.length === 0 && subject.name === 'MATA / OSINT SOCIAL MEDIA' && (
                                <div className="py-4 text-center text-muted-foreground text-sm">
                                  <p>No MATA/OSINT posts in the last 12 hours</p>
                                  <p className="text-xs mt-1">Toggle the airplane icon before submitting to tag posts here</p>
                                </div>
                              )}
                              {(activeSortedSubmissionsMap.get(subject.id) ?? []).map((submission) => (
                                <div 
                                  key={submission.id} 
                                  className={`pt-3 border-b last:border-b-0 pb-3 ${submission.isRead ? 'opacity-50' : ''}`}
                                  data-testid={`submission-${submission.id}`}
                                >
                                  <div className="flex items-start gap-2">
                                    <Checkbox
                                      checked={submission.isRead}
                                      onCheckedChange={() => toggleReadMutation.mutate(submission.id)}
                                      className="mt-0.5 flex-shrink-0"
                                      data-testid={`checkbox-read-${submission.id}`}
                                    />
                                    {submission.sourceType === 'social_media' ? (
                                      <Share2 className="h-4 w-4 text-blue-500 flex-shrink-0 mt-0.5" />
                                    ) : (
                                      <Newspaper className="h-4 w-4 text-orange-500 flex-shrink-0 mt-0.5" />
                                    )}
                                    <div className="flex-1 min-w-0">
                                      <a 
                                        href={submission.sourceUrl} 
                                        target="_blank" 
                                        rel="noopener noreferrer"
                                        className={`font-medium text-sm hover:text-primary inline-flex items-center gap-1 leading-tight ${submission.isRead ? 'text-muted-foreground' : ''}`}
                                        data-testid={`submission-link-${submission.id}`}
                                      >
                                        {submission.headline}
                                        <ExternalLink className="h-3 w-3 flex-shrink-0" />
                                      </a>
                                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                                        {submission.summary}
                                      </p>
                                      <div className="flex items-center justify-between gap-2 mt-2">
                                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                          <span>{submission.sourceName || 'Unknown Source'}</span>
                                          <span>•</span>
                                          <span>{format(new Date(submission.publishedAt || submission.createdAt), 'MMM d, h:mm a')}</span>
                                          {submission.clusterId && (() => {
                                            const relatedStories = getRelatedClusterSubmissions(subject.submissions, submission);
                                            const isExpanded = expandedClusters.has(submission.clusterId!);
                                            return relatedStories.length > 0 ? (
                                              <>
                                                <span>•</span>
                                                <span
                                                  role="button"
                                                  tabIndex={0}
                                                  onClick={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    toggleCluster(submission.clusterId!);
                                                  }}
                                                  onKeyDown={(e) => {
                                                    if (e.key === 'Enter' || e.key === ' ') {
                                                      e.preventDefault();
                                                      e.stopPropagation();
                                                      toggleCluster(submission.clusterId!);
                                                    }
                                                  }}
                                                  className="inline-flex items-center gap-1 text-purple-600 dark:text-purple-400 hover:underline cursor-pointer"
                                                  data-testid={`button-expand-cluster-${submission.id}`}
                                                >
                                                  <Layers className="h-3 w-3" />
                                                  {isExpanded ? 'Hide' : 'Show'} {relatedStories.length} related
                                                  {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                                </span>
                                              </>
                                            ) : (
                                              <>
                                                <span>•</span>
                                                <span className="inline-flex items-center gap-1 text-purple-600 dark:text-purple-400">
                                                  <Layers className="h-3 w-3" />
                                                  Clustered
                                                </span>
                                              </>
                                            );
                                          })()}
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                          {submission.isQuestionable ? (
                                            <span className="text-lg font-bold text-orange-600 dark:text-orange-400 px-1" data-testid={`questionable-indicator-${submission.id}`}>?</span>
                                          ) : (
                                          <Popover open={editingPriority === submission.id} onOpenChange={(open) => {
                                            if (open) {
                                              setEditingPriority(submission.id);
                                              setPriorityInputValue(String(submission.priorityScore || 0));
                                            } else {
                                              setEditingPriority(null);
                                            }
                                          }}>
                                            <PopoverTrigger asChild>
                                              <Button
                                                size="sm"
                                                variant="ghost"
                                                className={`text-xs ${(submission.priorityScore || 0) >= 75 ? 'text-amber-600 dark:text-amber-400' : ''}`}
                                                onClick={(e) => e.stopPropagation()}
                                                data-testid={`button-priority-${submission.id}`}
                                              >
                                                P: {submission.priorityScore ?? '—'}
                                              </Button>
                                            </PopoverTrigger>
                                            <PopoverContent className="w-48 p-3" onClick={(e) => e.stopPropagation()}>
                                              <div className="space-y-2">
                                                <Label className="text-xs">Priority Score (0-100)</Label>
                                                <div className="flex gap-2">
                                                  <Input
                                                    type="number"
                                                    min="0"
                                                    max="100"
                                                    value={priorityInputValue}
                                                    onChange={(e) => setPriorityInputValue(e.target.value)}
                                                    className="text-sm"
                                                    data-testid={`input-priority-${submission.id}`}
                                                  />
                                                  <Button
                                                    size="sm"
                                                    disabled={updatePriorityMutation.isPending}
                                                    onClick={() => {
                                                      const score = parseInt(priorityInputValue);
                                                      if (!isNaN(score) && score >= 0 && score <= 100) {
                                                        updatePriorityMutation.mutate({ 
                                                          submissionId: submission.id, 
                                                          priorityScore: score 
                                                        });
                                                        setEditingPriority(null);
                                                      } else {
                                                        toast({
                                                          title: "Invalid Score",
                                                          description: "Please enter a number between 0 and 100.",
                                                          variant: "destructive"
                                                        });
                                                      }
                                                    }}
                                                    data-testid={`button-save-priority-${submission.id}`}
                                                  >
                                                    Save
                                                  </Button>
                                                </div>
                                                <p className="text-xs text-muted-foreground">75+ adds to FLASH</p>
                                              </div>
                                            </PopoverContent>
                                          </Popover>
                                          )}
                                          <Button
                                            size="icon"
                                            variant="ghost"
                                            className={`${submission.isQuestionable ? 'text-orange-600 dark:text-orange-400' : 'text-muted-foreground'}`}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              toggleQuestionableMutation.mutate({ submissionId: submission.id, isQuestionable: !submission.isQuestionable });
                                            }}
                                            data-testid={`button-toggle-questionable-${submission.id}`}
                                          >
                                            <HelpCircle className="h-3.5 w-3.5" />
                                          </Button>
                                          {submission.isMataOsint && (
                                            <Button
                                              size="sm"
                                              variant={submission.flightTrackingPostedAt ? "ghost" : "default"}
                                              className={submission.flightTrackingPostedAt ? "text-teal-600 dark:text-teal-400 text-xs" : "bg-teal-600 text-white text-xs"}
                                              disabled={!!submission.flightTrackingPostedAt || postToFlightTrackingMutation.isPending}
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                postToFlightTrackingMutation.mutate(submission.id);
                                              }}
                                              data-testid={`button-post-flight-tracking-${submission.id}`}
                                            >
                                              <Plane className="h-3 w-3 mr-1" />
                                              {submission.flightTrackingPostedAt ? 'Posted' : 'Post'}
                                            </Button>
                                          )}
                                          <Popover open={editingTopic === submission.id} onOpenChange={(open) => {
                                            if (open) {
                                              setEditingTopic(submission.id);
                                              setNewTopicInput("");
                                            } else {
                                              setEditingTopic(null);
                                            }
                                          }}>
                                            <PopoverTrigger asChild>
                                              <Button
                                                size="icon"
                                                variant="ghost"
                                                onClick={(e) => e.stopPropagation()}
                                                title="Change topic"
                                                data-testid={`button-change-topic-${submission.id}`}
                                              >
                                                <FolderInput className="h-3.5 w-3.5" />
                                              </Button>
                                            </PopoverTrigger>
                                            <PopoverContent className="w-56 p-3" onClick={(e) => e.stopPropagation()}>
                                              <div className="space-y-3">
                                                <Label className="text-xs font-medium">Move to topic</Label>
                                                <Select
                                                  onValueChange={(topicId) => {
                                                    changeTopicMutation.mutate({ submissionId: submission.id, topicId });
                                                  }}
                                                >
                                                  <SelectTrigger className="text-sm">
                                                    <SelectValue placeholder="Select topic..." />
                                                  </SelectTrigger>
                                                  <SelectContent>
                                                    <TopicSelectItems
                                                      topics={allTopics}
                                                    />
                                                  </SelectContent>
                                                </Select>
                                                <div className="border-t pt-2">
                                                  <Label className="text-xs text-muted-foreground">Or create new topic</Label>
                                                  <div className="flex gap-2 mt-1">
                                                    <Input
                                                      placeholder="New topic name"
                                                      value={newTopicInput}
                                                      onChange={(e) => setNewTopicInput(e.target.value)}
                                                      className="text-sm"
                                                      data-testid={`input-new-topic-${submission.id}`}
                                                    />
                                                    <Button
                                                      size="sm"
                                                      disabled={!newTopicInput.trim() || changeTopicMutation.isPending}
                                                      onClick={() => {
                                                        if (newTopicInput.trim()) {
                                                          changeTopicMutation.mutate({ 
                                                            submissionId: submission.id, 
                                                            newTopicName: newTopicInput.trim() 
                                                          });
                                                        }
                                                      }}
                                                      data-testid={`button-create-topic-${submission.id}`}
                                                    >
                                                      <Plus className="h-4 w-4" />
                                                    </Button>
                                                  </div>
                                                </div>
                                              </div>
                                            </PopoverContent>
                                          </Popover>
                                          <Button
                                            size="sm"
                                            variant={submission.joeEmailedAt ? "ghost" : "outline"}
                                            className={submission.joeEmailedAt ? "text-muted-foreground" : ""}
                                            disabled={!!submission.joeEmailedAt}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              openJoeEmailDraft(submission);
                                            }}
                                            title={submission.joeEmailedAt ? `Joe email sent ${new Date(submission.joeEmailedAt).toLocaleString()}` : "Draft MCOP Alert email for Joe"}
                                            data-testid={`button-joe-${submission.id}`}
                                          >
                                            <Mail className="h-3 w-3 mr-1" />
                                            Joe
                                          </Button>
                                          {submission.sourceType !== 'social_media' && (
                                            submission.mcopSubmittedAt ? (
                                              <Button
                                                size="sm"
                                                variant="ghost"
                                                disabled
                                                className="h-6 text-xs px-2 text-muted-foreground"
                                                data-testid={`button-mcop-submitted-${submission.id}`}
                                              >
                                                Submitted
                                              </Button>
                                            ) : (
                                              <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  submitToMcopMutation.mutate(submission.id);
                                                }}
                                                disabled={submitToMcopMutation.isPending}
                                                className="h-6 text-xs px-2"
                                                data-testid={`button-mcop-${submission.id}`}
                                              >
                                                MCOP
                                              </Button>
                                            )
                                          )}
                                          {/* Cluster management dropdown */}
                                          <Popover>
                                            <PopoverTrigger asChild>
                                              <Button
                                                size="icon"
                                                variant="ghost"
                                                onClick={(e) => e.stopPropagation()}
                                                title={submission.clusterId ? "Manage cluster" : "Add to cluster"}
                                                data-testid={`button-cluster-${submission.id}`}
                                              >
                                                <Layers className="h-3 w-3" />
                                              </Button>
                                            </PopoverTrigger>
                                            <PopoverContent className="w-56 p-2" onClick={(e) => e.stopPropagation()}>
                                              <div className="space-y-2">
                                                <div className="text-xs font-semibold text-muted-foreground px-1">Cluster Management</div>
                                                
                                                {/* Unlink from cluster option */}
                                                {submission.clusterId && (
                                                  <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="w-full justify-start text-xs"
                                                    onClick={() => unlinkFromClusterMutation.mutate(submission.id)}
                                                    disabled={unlinkFromClusterMutation.isPending}
                                                    data-testid={`button-unlink-cluster-${submission.id}`}
                                                  >
                                                    <Trash2 className="h-3 w-3 mr-2" />
                                                    Remove from cluster
                                                  </Button>
                                                )}
                                                
                                                {/* Create new cluster option */}
                                                {creatingClusterFor?.submissionId === submission.id ? (
                                                  <div className="space-y-1">
                                                    <Input
                                                      placeholder="Cluster name..."
                                                      value={newClusterName}
                                                      onChange={(e) => setNewClusterName(e.target.value)}
                                                      className="text-xs"
                                                      data-testid={`input-new-cluster-${submission.id}`}
                                                      autoFocus
                                                    />
                                                    <div className="flex gap-1">
                                                      <Button
                                                        size="sm"
                                                        className="flex-1 text-xs"
                                                        disabled={!newClusterName.trim() || createClusterMutation.isPending}
                                                        onClick={() => {
                                                          if (newClusterName.trim()) {
                                                            createClusterMutation.mutate({
                                                              submissionId: submission.id,
                                                              clusterName: newClusterName.trim(),
                                                              subjectId: submission.subjectId || subject.id
                                                            });
                                                          }
                                                        }}
                                                        data-testid={`button-save-cluster-${submission.id}`}
                                                      >
                                                        Create
                                                      </Button>
                                                      <Button
                                                        size="sm"
                                                        variant="outline"
                                                        className="text-xs"
                                                        onClick={() => {
                                                          setCreatingClusterFor(null);
                                                          setNewClusterName("");
                                                        }}
                                                      >
                                                        Cancel
                                                      </Button>
                                                    </div>
                                                  </div>
                                                ) : (
                                                  <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="w-full justify-start text-xs"
                                                    onClick={() => setCreatingClusterFor({ submissionId: submission.id, subjectId: submission.subjectId || subject.id })}
                                                    data-testid={`button-new-cluster-${submission.id}`}
                                                  >
                                                    <Plus className="h-3 w-3 mr-2" />
                                                    Create new cluster
                                                  </Button>
                                                )}
                                                
                                                {/* Existing clusters */}
                                                {allClusters.length > 0 && (
                                                  <>
                                                    <div className="border-t my-1" />
                                                    <div className="text-xs font-semibold text-muted-foreground px-1">Move to existing cluster</div>
                                                    <ScrollArea className="max-h-32">
                                                      <div className="space-y-0.5">
                                                        {allClusters
                                                          .filter(c => c.id !== submission.clusterId)
                                                          .map(cluster => (
                                                            <Button
                                                              key={cluster.id}
                                                              variant="ghost"
                                                              size="sm"
                                                              className="w-full justify-start text-xs"
                                                              onClick={() => assignToClusterMutation.mutate({
                                                                submissionId: submission.id,
                                                                clusterId: cluster.id
                                                              })}
                                                              disabled={assignToClusterMutation.isPending}
                                                              data-testid={`button-assign-cluster-${cluster.id}-${submission.id}`}
                                                            >
                                                              <Layers className="h-3 w-3 mr-2" />
                                                              <span className="truncate flex-1 text-left">{cluster.name}</span>
                                                              <Badge variant="secondary" className="ml-1 text-[10px]">
                                                                {cluster.memberCount}
                                                              </Badge>
                                                            </Button>
                                                          ))
                                                        }
                                                      </div>
                                                    </ScrollArea>
                                                  </>
                                                )}
                                              </div>
                                            </PopoverContent>
                                          </Popover>
                                          <Button
                                            size="icon"
                                            variant="ghost"
                                            className="relative"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              const next = new Set(expandedComments);
                                              if (next.has(submission.id)) {
                                                next.delete(submission.id);
                                              } else {
                                                next.add(submission.id);
                                              }
                                              setExpandedComments(next);
                                            }}
                                            title="Comments"
                                            data-testid={`button-comments-${submission.id}`}
                                          >
                                            <MessageSquare className="h-3 w-3" />
                                            {(commentCounts[submission.id] || 0) > 0 && (
                                              <span className="absolute -top-1 -right-1 text-[9px] bg-primary text-primary-foreground rounded-full min-w-[14px] h-[14px] flex items-center justify-center leading-none">
                                                {commentCounts[submission.id]}
                                              </span>
                                            )}
                                          </Button>
                                          <Button
                                            size="icon"
                                            variant="ghost"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setSubmissionToDelete(submission);
                                              setDeleteConfirmOpen(true);
                                            }}
                                            title="Delete this submission"
                                            data-testid={`button-delete-${submission.id}`}
                                          >
                                            <Trash2 className="h-3 w-3" />
                                          </Button>
                                        </div>
                                      </div>
                                      {expandedComments.has(submission.id) && (
                                        <SubmissionComments
                                          submissionId={submission.id}
                                          commentInput={commentInputs[submission.id] || ''}
                                          onCommentInputChange={(val) => setCommentInputs(prev => ({ ...prev, [submission.id]: val }))}
                                          onSubmitComment={() => {
                                            const text = commentInputs[submission.id]?.trim();
                                            if (text) {
                                              addCommentMutation.mutate({ submissionId: submission.id, text });
                                            }
                                          }}
                                          isSubmitting={addCommentMutation.isPending}
                                          onDeleteComment={(commentId) => deleteCommentMutation.mutate({ submissionId: submission.id, commentId })}
                                          isDeletingComment={deleteCommentMutation.isPending}
                                        />
                                      )}
                                    </div>
                                  </div>
                                  {submission.clusterId && expandedClusters.has(submission.clusterId) && (() => {
                                    const relatedStories = getRelatedClusterSubmissions(subject.submissions, submission);
                                    return relatedStories.length > 0 ? (
                                      <div className="mt-2 ml-6 pl-3 border-l-2 border-purple-300 dark:border-purple-700 space-y-2">
                                        <div className="text-xs text-purple-600 dark:text-purple-400 font-medium">Related Stories:</div>
                                        {relatedStories.map(related => (
                                          <div key={related.id} className="text-xs">
                                            <a 
                                              href={related.sourceUrl}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="hover:text-primary inline-flex items-center gap-1"
                                              data-testid={`related-link-${related.id}`}
                                            >
                                              {related.headline}
                                              <ExternalLink className="h-2.5 w-2.5" />
                                            </a>
                                            <div className="text-muted-foreground">
                                              {related.sourceName} • {format(new Date(related.publishedAt || related.createdAt), 'MMM d, h:mm a')}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    ) : null;
                                  })()}
                                </div>
                              ))}
                            </div>
                          </CollapsibleContent>
                        </Card>
                      </Collapsible>
                      );
                    })
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
          
          <Dialog>
            <DialogTrigger asChild>
              <Card className="flex-shrink-0 cursor-pointer hover-elevate" data-testid="button-older-topics">
                <CardHeader className="py-3">
                  <CardTitle className="text-base flex items-center justify-between gap-2 text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <Clock className="h-5 w-5" />
                      Older Topics
                    </div>
                    <div className="flex items-center gap-2">
                      {visibleArchivedSubjects.length > 0 && (
                        <Badge variant="secondary" className="text-xs">
                          {visibleArchivedSubjects.length} topics
                        </Badge>
                      )}
                      <ChevronRight className="h-4 w-4" />
                    </div>
                  </CardTitle>
                </CardHeader>
              </Card>
            </DialogTrigger>
            <DialogContent className="max-w-2xl h-[80vh] flex flex-col">
              <DialogHeader className="flex-shrink-0 pb-4">
                <DialogTitle className="flex items-center gap-2">
                  <Clock className="h-5 w-5" />
                  Older Topics
                </DialogTitle>
              </DialogHeader>
              <div className="flex-1 overflow-y-auto min-h-0 max-h-[calc(80vh-100px)] pr-2">
                <div className="space-y-3">
                  {subjectsLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                    </div>
                  ) : visibleArchivedSubjects.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                      <Clock className="h-12 w-12 mb-3 opacity-50" />
                      <p className="text-sm">No older topics yet</p>
                    </div>
                  ) : (
                    visibleArchivedSubjects.map((subject) => (
                      <Collapsible
                        key={`archived-${subject.id}`}
                        open={expandedSubjects.has(`archived-${subject.id}`)}
                        onOpenChange={() => toggleSubject(`archived-${subject.id}`)}
                      >
                        <Card className={`overflow-hidden opacity-75 ${subject.name === 'CJCS MENTIONS' ? 'border-blue-500/50 bg-blue-500/5' : ''}`}>
                          <CollapsibleTrigger className="w-full" data-testid={`archived-subject-trigger-${subject.id}`}>
                            <div className="flex items-center justify-between p-3 hover-elevate">
                              <div className="flex items-center gap-2">
                                {expandedSubjects.has(`archived-${subject.id}`) ? (
                                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                )}
                                <span className={`font-medium text-sm ${subject.name === 'CJCS MENTIONS' ? 'text-blue-600 dark:text-blue-400' : ''}`}>{subject.name}</span>
                              </div>
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                {(subject.unreadNewsCount > 0 || subject.unreadSocialCount > 0) ? (
                                  <>
                                    {subject.unreadNewsCount > 0 && (
                                      <Badge variant="secondary" className="text-xs">
                                        {subject.unreadNewsCount} News
                                      </Badge>
                                    )}
                                    {subject.unreadSocialCount > 0 && (
                                      <Badge variant="outline" className="text-xs">
                                        {subject.unreadSocialCount} Social
                                      </Badge>
                                    )}
                                  </>
                                ) : (
                                  <span className="text-muted-foreground/60">All read</span>
                                )}
                                {subject.name !== 'FLASH: TOP STORIES' && subject.name !== 'MOST RECENT' && subject.name !== 'CJCS MENTIONS' && subject.name !== 'MATA / OSINT SOCIAL MEDIA' && (
                                  <>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setTopicToDelete(subject);
                                        setDeleteTopicConfirmOpen(true);
                                      }}
                                      data-testid={`button-delete-archived-topic-${subject.id}`}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  </>
                                )}
                              </div>
                            </div>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <div className="border-t px-3 pb-3 space-y-3">
                              {(archivedSortedSubmissionsMap.get(subject.id) ?? []).map((submission) => (
                                <div 
                                  key={submission.id} 
                                  className={`pt-3 border-b last:border-b-0 pb-3 ${submission.isRead ? 'opacity-50' : ''}`}
                                  data-testid={`archived-submission-${submission.id}`}
                                >
                                  <div className="flex items-start gap-2">
                                    <Checkbox
                                      checked={submission.isRead}
                                      onCheckedChange={() => toggleReadMutation.mutate(submission.id)}
                                      className="mt-0.5 flex-shrink-0"
                                      data-testid={`archived-checkbox-read-${submission.id}`}
                                    />
                                    {submission.sourceType === 'social_media' ? (
                                      <Share2 className="h-4 w-4 text-blue-500 flex-shrink-0 mt-0.5" />
                                    ) : (
                                      <Newspaper className="h-4 w-4 text-orange-500 flex-shrink-0 mt-0.5" />
                                    )}
                                    <div className="flex-1 min-w-0">
                                      <a 
                                        href={submission.sourceUrl} 
                                        target="_blank" 
                                        rel="noopener noreferrer"
                                        className={`font-medium text-sm hover:text-primary inline-flex items-center gap-1 leading-tight ${submission.isRead ? 'text-muted-foreground' : ''}`}
                                        data-testid={`archived-submission-link-${submission.id}`}
                                      >
                                        {submission.headline}
                                        <ExternalLink className="h-3 w-3 flex-shrink-0" />
                                      </a>
                                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                                        {submission.summary}
                                      </p>
                                      <div className="flex items-center justify-between gap-2 mt-2">
                                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                          <span>{submission.sourceName || 'Unknown Source'}</span>
                                          <span>•</span>
                                          <span>{format(new Date(submission.publishedAt || submission.createdAt), 'MMM d, h:mm a')}</span>
                                          {submission.clusterId && (() => {
                                            const relatedStories = getRelatedClusterSubmissions(subject.submissions, submission);
                                            const isExpanded = expandedClusters.has(submission.clusterId!);
                                            return relatedStories.length > 0 ? (
                                              <>
                                                <span>•</span>
                                                <span
                                                  role="button"
                                                  tabIndex={0}
                                                  onClick={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    toggleCluster(submission.clusterId!);
                                                  }}
                                                  onKeyDown={(e) => {
                                                    if (e.key === 'Enter' || e.key === ' ') {
                                                      e.preventDefault();
                                                      e.stopPropagation();
                                                      toggleCluster(submission.clusterId!);
                                                    }
                                                  }}
                                                  className="inline-flex items-center gap-1 text-purple-600 dark:text-purple-400 hover:underline cursor-pointer"
                                                  data-testid={`archived-button-expand-cluster-${submission.id}`}
                                                >
                                                  <Layers className="h-3 w-3" />
                                                  {isExpanded ? 'Hide' : 'Show'} {relatedStories.length} related
                                                  {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                                </span>
                                              </>
                                            ) : (
                                              <>
                                                <span>•</span>
                                                <span className="inline-flex items-center gap-1 text-purple-600 dark:text-purple-400">
                                                  <Layers className="h-3 w-3" />
                                                  Clustered
                                                </span>
                                              </>
                                            );
                                          })()}
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                          {submission.isQuestionable ? (
                                            <span className="text-lg font-bold text-orange-600 dark:text-orange-400 px-1" data-testid={`archived-questionable-indicator-${submission.id}`}>?</span>
                                          ) : (
                                          <Popover open={editingPriority === `archived-${submission.id}`} onOpenChange={(open) => {
                                            if (open) {
                                              setEditingPriority(`archived-${submission.id}`);
                                              setPriorityInputValue(String(submission.priorityScore || 0));
                                            } else {
                                              setEditingPriority(null);
                                            }
                                          }}>
                                            <PopoverTrigger asChild>
                                              <Button
                                                size="sm"
                                                variant="ghost"
                                                className={`text-xs ${(submission.priorityScore || 0) >= 75 ? 'text-amber-600 dark:text-amber-400' : ''}`}
                                                onClick={(e) => e.stopPropagation()}
                                                data-testid={`archived-button-priority-${submission.id}`}
                                              >
                                                P: {submission.priorityScore ?? '—'}
                                              </Button>
                                            </PopoverTrigger>
                                            <PopoverContent className="w-48 p-3" onClick={(e) => e.stopPropagation()}>
                                              <div className="space-y-2">
                                                <Label className="text-xs">Priority Score (0-100)</Label>
                                                <div className="flex gap-2">
                                                  <Input
                                                    type="number"
                                                    min="0"
                                                    max="100"
                                                    value={priorityInputValue}
                                                    onChange={(e) => setPriorityInputValue(e.target.value)}
                                                    className="text-sm"
                                                    data-testid={`archived-input-priority-${submission.id}`}
                                                  />
                                                  <Button
                                                    size="sm"
                                                    disabled={updatePriorityMutation.isPending}
                                                    onClick={() => {
                                                      const score = parseInt(priorityInputValue);
                                                      if (!isNaN(score) && score >= 0 && score <= 100) {
                                                        updatePriorityMutation.mutate({ 
                                                          submissionId: submission.id, 
                                                          priorityScore: score 
                                                        });
                                                        setEditingPriority(null);
                                                      } else {
                                                        toast({
                                                          title: "Invalid Score",
                                                          description: "Please enter a number between 0 and 100.",
                                                          variant: "destructive"
                                                        });
                                                      }
                                                    }}
                                                    data-testid={`archived-button-save-priority-${submission.id}`}
                                                  >
                                                    Save
                                                  </Button>
                                                </div>
                                                <p className="text-xs text-muted-foreground">75+ adds to FLASH</p>
                                              </div>
                                            </PopoverContent>
                                          </Popover>
                                          )}
                                          <Button
                                            size="icon"
                                            variant="ghost"
                                            className={`${submission.isQuestionable ? 'text-orange-600 dark:text-orange-400' : 'text-muted-foreground'}`}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              toggleQuestionableMutation.mutate({ submissionId: submission.id, isQuestionable: !submission.isQuestionable });
                                            }}
                                            data-testid={`archived-button-toggle-questionable-${submission.id}`}
                                          >
                                            <HelpCircle className="h-3.5 w-3.5" />
                                          </Button>
                                          <Popover open={editingTopic === `archived-${submission.id}`} onOpenChange={(open) => {
                                            if (open) {
                                              setEditingTopic(`archived-${submission.id}`);
                                              setNewTopicInput("");
                                            } else {
                                              setEditingTopic(null);
                                            }
                                          }}>
                                            <PopoverTrigger asChild>
                                              <Button
                                                size="icon"
                                                variant="ghost"
                                                onClick={(e) => e.stopPropagation()}
                                                title="Change topic"
                                                data-testid={`archived-button-change-topic-${submission.id}`}
                                              >
                                                <FolderInput className="h-3.5 w-3.5" />
                                              </Button>
                                            </PopoverTrigger>
                                            <PopoverContent className="w-56 p-3" onClick={(e) => e.stopPropagation()}>
                                              <div className="space-y-3">
                                                <Label className="text-xs font-medium">Move to topic</Label>
                                                <Select
                                                  onValueChange={(topicId) => {
                                                    changeTopicMutation.mutate({ submissionId: submission.id, topicId });
                                                  }}
                                                >
                                                  <SelectTrigger className="text-sm">
                                                    <SelectValue placeholder="Select topic..." />
                                                  </SelectTrigger>
                                                  <SelectContent>
                                                    <TopicSelectItems
                                                      topics={allTopics}
                                                    />
                                                  </SelectContent>
                                                </Select>
                                                <div className="border-t pt-2">
                                                  <Label className="text-xs text-muted-foreground">Or create new topic</Label>
                                                  <div className="flex gap-2 mt-1">
                                                    <Input
                                                      placeholder="New topic name"
                                                      value={newTopicInput}
                                                      onChange={(e) => setNewTopicInput(e.target.value)}
                                                      className="text-sm"
                                                      data-testid={`archived-input-new-topic-${submission.id}`}
                                                    />
                                                    <Button
                                                      size="sm"
                                                      disabled={!newTopicInput.trim() || changeTopicMutation.isPending}
                                                      onClick={() => {
                                                        if (newTopicInput.trim()) {
                                                          changeTopicMutation.mutate({ 
                                                            submissionId: submission.id, 
                                                            newTopicName: newTopicInput.trim() 
                                                          });
                                                        }
                                                      }}
                                                      data-testid={`archived-button-create-topic-${submission.id}`}
                                                    >
                                                      <Plus className="h-4 w-4" />
                                                    </Button>
                                                  </div>
                                                </div>
                                              </div>
                                            </PopoverContent>
                                          </Popover>
                                          {submission.sourceType !== 'social_media' && (
                                            submission.mcopSubmittedAt ? (
                                              <Button
                                                size="sm"
                                                variant="ghost"
                                                disabled
                                                className="h-6 text-xs px-2 text-muted-foreground"
                                                data-testid={`archived-button-mcop-submitted-${submission.id}`}
                                              >
                                                Submitted
                                              </Button>
                                            ) : (
                                              <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  submitToMcopMutation.mutate(submission.id);
                                                }}
                                                disabled={submitToMcopMutation.isPending}
                                                className="h-6 text-xs px-2"
                                                data-testid={`archived-button-mcop-${submission.id}`}
                                              >
                                                MCOP
                                              </Button>
                                            )
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                  {submission.clusterId && expandedClusters.has(submission.clusterId) && (() => {
                                    const relatedStories = getRelatedClusterSubmissions(subject.submissions, submission);
                                    return relatedStories.length > 0 ? (
                                      <div className="mt-2 ml-6 pl-3 border-l-2 border-purple-300 dark:border-purple-700 space-y-2">
                                        <div className="text-xs text-purple-600 dark:text-purple-400 font-medium">Related Stories:</div>
                                        {relatedStories.map(related => (
                                          <div key={related.id} className="text-xs">
                                            <a 
                                              href={related.sourceUrl}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="hover:text-primary inline-flex items-center gap-1"
                                              data-testid={`archived-related-link-${related.id}`}
                                            >
                                              {related.headline}
                                              <ExternalLink className="h-2.5 w-2.5" />
                                            </a>
                                            <div className="text-muted-foreground">
                                              {related.sourceName} • {format(new Date(related.publishedAt || related.createdAt), 'MMM d, h:mm a')}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    ) : null;
                                  })()}
                                </div>
                              ))}
                            </div>
                          </CollapsibleContent>
                        </Card>
                      </Collapsible>
                    ))
                  )}
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </main>
      
      <MCOPBotDialog open={mcopBotOpen} onOpenChange={setMcopBotOpen} />

      {/* News Scrub Dialog */}
      <Dialog open={newsScrubOpen} onOpenChange={setNewsScrubOpen}>
        <DialogContent className="sm:max-w-[450px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2" data-testid="news-scrub-dialog-title">
              <FileText className="w-5 h-5" />
              News Scrub
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              What time period would you like covered in the News Scrub?
            </p>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>From Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full justify-start text-left font-normal"
                      data-testid="news-scrub-from-date"
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {newsScrubFromDate ? format(newsScrubFromDate, "MMM d, yyyy") : "Select date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={newsScrubFromDate}
                      onSelect={setNewsScrubFromDate}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
              
              <div className="space-y-2">
                <Label>From Time (ET)</Label>
                <Input
                  type="time"
                  value={newsScrubFromTime}
                  onChange={(e) => setNewsScrubFromTime(e.target.value)}
                  data-testid="news-scrub-from-time"
                />
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>To Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full justify-start text-left font-normal"
                      data-testid="news-scrub-to-date"
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {newsScrubToDate ? format(newsScrubToDate, "MMM d, yyyy") : "Select date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={newsScrubToDate}
                      onSelect={setNewsScrubToDate}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
              
              <div className="space-y-2">
                <Label>To Time (ET)</Label>
                <Input
                  type="time"
                  value={newsScrubToTime}
                  onChange={(e) => setNewsScrubToTime(e.target.value)}
                  data-testid="news-scrub-to-time"
                />
              </div>
            </div>
            
            <div className="space-y-2">
              <Label>Be on the Lookout for (optional)</Label>
              <Textarea
                placeholder="Enter subjects or topics to specifically look for in this report (e.g., 'Greenland negotiations', 'NATO alliance discussions'). The report will not be limited to these subjects, but will prioritize them if found."
                value={newsScrubBolo}
                onChange={(e) => setNewsScrubBolo(e.target.value)}
                className="min-h-[80px] text-sm"
                data-testid="news-scrub-bolo"
              />
            </div>
            
            <Button
              className="w-full"
              onClick={async () => {
                if (!newsScrubFromDate || !newsScrubToDate) {
                  toast({
                    title: "Please select dates",
                    description: "Both 'From' and 'To' dates are required.",
                    variant: "destructive",
                  });
                  return;
                }
                
                // Combine date and time
                const [fromHours, fromMinutes] = newsScrubFromTime.split(':').map(Number);
                const [toHours, toMinutes] = newsScrubToTime.split(':').map(Number);
                
                const fromDateTime = new Date(newsScrubFromDate);
                fromDateTime.setHours(fromHours, fromMinutes, 0, 0);
                
                const toDateTime = new Date(newsScrubToDate);
                toDateTime.setHours(toHours, toMinutes, 0, 0);
                
                if (fromDateTime >= toDateTime) {
                  toast({
                    title: "Invalid time range",
                    description: "'From' time must be before 'To' time.",
                    variant: "destructive",
                  });
                  return;
                }
                
                setNewsScrubGenerating(true);
                
                try {
                  const response = await fetch('/api/team/news-scrub', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      fromDate: fromDateTime.toISOString(),
                      toDate: toDateTime.toISOString(),
                      boloTopics: newsScrubBolo.trim() || undefined,
                    }),
                  });
                  
                  if (!response.ok) {
                    throw new Error('Failed to generate News Scrub');
                  }
                  
                  const blob = await response.blob();
                  const url = window.URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `News_Scrub_${format(fromDateTime, 'yyyy-MM-dd_HHmm')}_to_${format(toDateTime, 'yyyy-MM-dd_HHmm')}.docx`;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  window.URL.revokeObjectURL(url);
                  
                  setNewsScrubOpen(false);
                  toast({
                    title: "News Scrub Generated",
                    description: "Your document has been downloaded.",
                  });
                } catch (error) {
                  toast({
                    title: "Error",
                    description: "Failed to generate News Scrub. Please try again.",
                    variant: "destructive",
                  });
                } finally {
                  setNewsScrubGenerating(false);
                }
              }}
              disabled={newsScrubGenerating || !newsScrubFromDate || !newsScrubToDate}
              data-testid="button-generate-news-scrub"
            >
              {newsScrubGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <FileText className="w-4 h-4 mr-2" />
                  Generate News Scrub
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Daily News Scrub Upload Dialog */}
      <Dialog open={scrubUploadOpen} onOpenChange={(open) => {
        setScrubUploadOpen(open);
        if (!open) {
          setScrubFileName("");
          if (scrubFileRef.current) scrubFileRef.current.value = "";
        }
      }}>
        <DialogContent className="sm:max-w-[500px]" onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2" data-testid="scrub-upload-dialog-title">
              <Upload className="w-5 h-5" />
              Upload Daily News Scrub
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>PDF File</Label>
              <input
                ref={scrubFileRef}
                type="file"
                accept=".pdf,application/pdf"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  setScrubFileName(file ? file.name : "");
                }}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                data-testid="input-scrub-file"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>CAO Date</Label>
                <Popover modal={false}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full justify-start text-left font-normal"
                      data-testid="scrub-cao-date"
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {scrubCaoDate ? format(scrubCaoDate, "MMM d, yyyy") : "Select date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={scrubCaoDate}
                      onSelect={setScrubCaoDate}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
              
              <div className="space-y-2">
                <Label>CAO Time</Label>
                <Input
                  type="time"
                  value={scrubCaoTime}
                  onChange={(e) => setScrubCaoTime(e.target.value)}
                  data-testid="scrub-cao-time"
                />
              </div>
            </div>
            
            <Button
              className="w-full"
              onClick={async () => {
                const scrubFile = scrubFileRef.current?.files?.[0];
                if (!scrubFile || !scrubCaoDate) {
                  toast({
                    title: "Missing fields",
                    description: "Please select a PDF file and CAO date.",
                    variant: "destructive",
                  });
                  return;
                }
                
                const [hours, minutes] = scrubCaoTime.split(':').map(Number);
                const caoDateTime = new Date(scrubCaoDate);
                caoDateTime.setHours(hours, minutes, 0, 0);
                
                setScrubUploading(true);
                try {
                  // Step 1: get a presigned URL so we can upload the PDF straight
                  // to object storage (bypasses the server's request-size limit).
                  const urlRes = await fetch('/api/team/daily-news-scrub/upload-url', {
                    method: 'POST',
                    credentials: 'include',
                  });
                  if (!urlRes.ok) {
                    throw new Error('Could not start the upload. Please try again.');
                  }
                  const { uploadURL } = await urlRes.json();

                  // Step 2: PUT the file directly to storage.
                  const putRes = await fetch(uploadURL, {
                    method: 'PUT',
                    body: scrubFile,
                    headers: { 'Content-Type': 'application/pdf' },
                  });
                  if (!putRes.ok) {
                    throw new Error('The file could not be uploaded to storage. Please try again.');
                  }

                  // Step 3: record the upload (small JSON only).
                  const response = await fetch('/api/team/daily-news-scrub', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({
                      uploadURL,
                      filename: scrubFile.name,
                      caoDate: caoDateTime.toISOString(),
                    }),
                  });
                  
                  if (!response.ok) {
                    const raw = await response.text();
                    let message = 'Upload failed';
                    try {
                      message = JSON.parse(raw).error || message;
                    } catch {
                      if (response.status === 502 || response.status === 503 || response.status === 504) {
                        message = 'The server took too long to respond. The file may still have uploaded — please refresh and check the archive.';
                      } else {
                        message = `Upload failed (server error ${response.status}). Please try again.`;
                      }
                    }
                    throw new Error(message);
                  }
                  
                  toast({
                    title: "Daily News Scrub Uploaded",
                    description: "The scrub is now available for download on the Dashboard and Stream pages.",
                  });
                  setScrubFileName("");
                  if (scrubFileRef.current) scrubFileRef.current.value = "";
                  refetchScrubArchive();
                } catch (error: any) {
                  toast({
                    title: "Upload Failed",
                    description: error.message,
                    variant: "destructive",
                  });
                } finally {
                  setScrubUploading(false);
                }
              }}
              disabled={scrubUploading || !scrubFileName || !scrubCaoDate}
              data-testid="button-upload-scrub-submit"
            >
              {scrubUploading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4 mr-2" />
                  Upload Daily News Scrub
                </>
              )}
            </Button>

            {scrubArchive && scrubArchive.length > 0 && (
              <div className="space-y-2 pt-4 border-t">
                <Label className="text-sm font-medium">Previously Uploaded Scrubs</Label>
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {scrubArchive.map((scrub: any) => {
                    const d = new Date(scrub.caoDate);
                    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
                    const dd = String(d.getDate()).padStart(2, '0');
                    const mon = months[d.getMonth()];
                    const yyyy = d.getFullYear();
                    const hh = String(d.getHours()).padStart(2, '0');
                    const mm = String(d.getMinutes()).padStart(2, '0');
                    const caoStr = `${dd}${mon}${yyyy} ${hh}:${mm}`;
                    return (
                      <div key={scrub.id} className="flex items-center justify-between text-sm p-2 rounded bg-muted/50">
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium">{scrub.filename}</span>
                          <span className="text-xs text-muted-foreground">CAO: {caoStr}{scrub.uploadedBy ? ` | By: ${scrub.uploadedBy}` : ''}</span>
                        </div>
                        <a href={`/api/daily-news-scrub/${scrub.id}/download`} download>
                          <Button size="sm" variant="ghost" data-testid={`button-download-archive-${scrub.id}`}>
                            <Download className="w-3.5 h-3.5 mr-1" />
                            Download
                          </Button>
                        </a>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Briefing Card Dialog */}
      <Dialog open={briefingCardOpen} onOpenChange={setBriefingCardOpen}>
        <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2" data-testid="briefing-card-dialog-title">
              <ClipboardList className="w-5 h-5" />
              Generate Briefing Card
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Generate a 5.5" x 8.5" briefing card composed from curated intelligence, senior official messaging, and Team submissions.
            </p>

            <div className="space-y-2">
              <Label className="text-sm font-medium">Sections</Label>
              <div className="grid grid-cols-1 gap-2 rounded-md border p-3">
                {ALL_BRIEFING_SECTIONS.map(key => (
                  <div key={key} className="flex items-center gap-2">
                    <Checkbox
                      id={`section-${key}`}
                      checked={briefingCardSections.has(key)}
                      onCheckedChange={() => toggleBriefingSection(key)}
                      data-testid={`briefing-section-${key}`}
                    />
                    <label
                      htmlFor={`section-${key}`}
                      className="text-sm cursor-pointer select-none"
                    >
                      {BRIEFING_SECTION_LABELS[key]}
                    </label>
                  </div>
                ))}
                <div className="flex gap-2 pt-1 border-t mt-1">
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground underline"
                    onClick={() => setBriefingCardSections(new Set(ALL_BRIEFING_SECTIONS))}
                  >
                    Select all
                  </button>
                  <span className="text-xs text-muted-foreground">·</span>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground underline"
                    onClick={() => setBriefingCardSections(new Set())}
                  >
                    Clear all
                  </button>
                </div>
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>From Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full justify-start text-left font-normal"
                      data-testid="briefing-card-from-date"
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {briefingCardFromDate ? format(briefingCardFromDate, "MMM d, yyyy") : "Select date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={briefingCardFromDate}
                      onSelect={setBriefingCardFromDate}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
              
              <div className="space-y-2">
                <Label>From Time (ET)</Label>
                <Input
                  type="time"
                  value={briefingCardFromTime}
                  onChange={(e) => setBriefingCardFromTime(e.target.value)}
                  data-testid="briefing-card-from-time"
                />
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>To Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full justify-start text-left font-normal"
                      data-testid="briefing-card-to-date"
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {briefingCardToDate ? format(briefingCardToDate, "MMM d, yyyy") : "Select date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={briefingCardToDate}
                      onSelect={setBriefingCardToDate}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
              
              <div className="space-y-2">
                <Label>To Time (ET)</Label>
                <Input
                  type="time"
                  value={briefingCardToTime}
                  onChange={(e) => setBriefingCardToTime(e.target.value)}
                  data-testid="briefing-card-to-time"
                />
              </div>
            </div>
            
            <div className="space-y-2">
              <Label>Be on the Lookout for (optional)</Label>
              <Textarea
                placeholder="Enter subjects or topics to specifically look for (e.g., 'Greenland negotiations', 'NATO alliance discussions'). The briefing will prioritize these topics if found."
                value={briefingCardBolo}
                onChange={(e) => setBriefingCardBolo(e.target.value)}
                className="min-h-[80px] text-sm"
                data-testid="briefing-card-bolo"
              />
            </div>
            
            <div className="grid grid-cols-2 gap-2">
              <Button
                className="w-full"
                onClick={async () => {
                  if (!briefingCardFromDate || !briefingCardToDate) {
                    toast({
                      title: "Please select dates",
                      description: "Both 'From' and 'To' dates are required.",
                      variant: "destructive",
                    });
                    return;
                  }
                  
                  const [fromHours, fromMinutes] = briefingCardFromTime.split(':').map(Number);
                  const [toHours, toMinutes] = briefingCardToTime.split(':').map(Number);
                  
                  const fromDateTime = new Date(briefingCardFromDate);
                  fromDateTime.setHours(fromHours, fromMinutes, 0, 0);
                  
                  const toDateTime = new Date(briefingCardToDate);
                  toDateTime.setHours(toHours, toMinutes, 0, 0);
                  
                  if (fromDateTime >= toDateTime) {
                    toast({
                      title: "Invalid time range",
                      description: "'From' time must be before 'To' time.",
                      variant: "destructive",
                    });
                    return;
                  }
                  
                  setBriefingCardGenerating(true);
                  
                  try {
                    const response = await fetch('/api/team/briefing-card', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        fromDate: fromDateTime.toISOString(),
                        toDate: toDateTime.toISOString(),
                        bolo: briefingCardBolo || undefined,
                        sections: Array.from(briefingCardSections),
                      }),
                    });
                    
                    if (!response.ok) {
                      throw new Error('Failed to generate Briefing Card');
                    }
                    
                    const blob = await response.blob();
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `Briefing_Card_${format(toDateTime, 'yyyy-MM-dd')}.docx`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    window.URL.revokeObjectURL(url);
                    
                    setBriefingCardOpen(false);
                    toast({
                      title: "Briefing Card Generated",
                      description: "Your Word document has been downloaded.",
                    });
                  } catch (error) {
                    toast({
                      title: "Error",
                      description: "Failed to generate Briefing Card. Please try again.",
                      variant: "destructive",
                    });
                  } finally {
                    setBriefingCardGenerating(false);
                  }
                }}
                disabled={briefingCardGenerating || !briefingCardFromDate || !briefingCardToDate}
                data-testid="button-download-briefing-card"
              >
                {briefingCardGenerating ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4 mr-2" />
                    Download Word
                  </>
                )}
              </Button>
              
              <Button
                variant="outline"
                className="w-full"
                onClick={async () => {
                  if (!briefingCardFromDate || !briefingCardToDate) {
                    toast({
                      title: "Please select dates",
                      description: "Both 'From' and 'To' dates are required.",
                      variant: "destructive",
                    });
                    return;
                  }
                  
                  const [fromHours, fromMinutes] = briefingCardFromTime.split(':').map(Number);
                  const [toHours, toMinutes] = briefingCardToTime.split(':').map(Number);
                  
                  const fromDateTime = new Date(briefingCardFromDate);
                  fromDateTime.setHours(fromHours, fromMinutes, 0, 0);
                  
                  const toDateTime = new Date(briefingCardToDate);
                  toDateTime.setHours(toHours, toMinutes, 0, 0);
                  
                  if (fromDateTime >= toDateTime) {
                    toast({
                      title: "Invalid time range",
                      description: "'From' time must be before 'To' time.",
                      variant: "destructive",
                    });
                    return;
                  }
                  
                  setBriefingCardGenerating(true);
                  
                  try {
                    const response = await fetch('/api/team/briefing-card/html', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        fromDate: fromDateTime.toISOString(),
                        toDate: toDateTime.toISOString(),
                        bolo: briefingCardBolo || undefined,
                        sections: Array.from(briefingCardSections),
                      }),
                    });
                    
                    if (!response.ok) {
                      throw new Error('Failed to generate Briefing Card for print');
                    }
                    
                    const html = await response.text();
                    const printWindow = window.open('', '_blank');
                    if (printWindow) {
                      printWindow.document.write(html);
                      printWindow.document.close();
                    }
                    
                    setBriefingCardOpen(false);
                    toast({
                      title: "Print Preview Opened",
                      description: "A print preview window has been opened.",
                    });
                  } catch (error) {
                    toast({
                      title: "Error",
                      description: "Failed to generate print preview. Please try again.",
                      variant: "destructive",
                    });
                  } finally {
                    setBriefingCardGenerating(false);
                  }
                }}
                disabled={briefingCardGenerating || !briefingCardFromDate || !briefingCardToDate}
                data-testid="button-print-briefing-card"
              >
                {briefingCardGenerating ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Printer className="w-4 h-4 mr-2" />
                    Print
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this submission?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{submissionToDelete?.headline?.substring(0, 80)}{submissionToDelete?.headline && submissionToDelete.headline.length > 80 ? '...' : ''}"? 
              This will remove it from Content Coverage and prevent bots from posting it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-delete-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (submissionToDelete) {
                  deleteSubmissionMutation.mutate(submissionToDelete.id);
                }
              }}
              disabled={deleteSubmissionMutation.isPending}
              data-testid="button-delete-confirm"
            >
              {deleteSubmissionMutation.isPending ? 'Deleting...' : 'Yes, delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingAiProvider !== null}
        onOpenChange={(open) => { if (!open) setPendingAiProvider(null); }}
      >
        <AlertDialogContent className="max-w-lg" data-testid="dialog-ai-provider-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="text-ai-confirm-title">
              Switch all AI to {pendingAiProvider === 'auto' ? 'Auto' : pendingAiProvider === 'internal' ? 'Internal AI' : 'OpenRouter'}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  {pendingAiProvider === 'auto'
                    ? 'MCOP will pick the AI provider automatically for every task below, preferring OpenRouter but switching to the Internal AI the moment OpenRouter gets rate-limited — and switching back once it recovers. No manual switching needed.'
                    : pendingAiProvider === 'internal'
                      ? 'Every AI task below will run on the Internal AI first, with automatic fallback to OpenRouter if the Internal AI is unavailable.'
                      : 'Every AI task below will run on OpenRouter first, with automatic fallback to the Internal AI if OpenRouter is unavailable.'}
                </p>
                <p className="font-medium text-foreground">This change applies to:</p>
                <ul className="list-disc space-y-1 pl-5 text-sm max-h-60 overflow-y-auto">
                  {AI_PROVIDER_SWITCHED_FEATURES.map((feature, i) => (
                    <li key={feature} data-testid={`text-ai-feature-${i}`}>{feature}</li>
                  ))}
                </ul>
                <p className="text-sm">
                  This selection stays in place until someone changes it here. It survives restarts
                  and applies to background bots and scheduled jobs.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-ai-confirm-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingAiProvider) aiProviderMutation.mutate(pendingAiProvider);
                setPendingAiProvider(null);
              }}
              disabled={aiProviderMutation.isPending}
              data-testid="button-ai-confirm-apply"
            >
              Switch to {pendingAiProvider === 'auto' ? 'Auto' : pendingAiProvider === 'internal' ? 'Internal AI' : 'OpenRouter'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteTopicConfirmOpen} onOpenChange={setDeleteTopicConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Topic</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete Topic "{topicToDelete?.name}"? This will delete all content, and move items to the closest corresponding topic.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-delete-topic-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (topicToDelete) {
                  deleteTopicMutation.mutate(topicToDelete.id);
                }
              }}
              disabled={deleteTopicMutation.isPending}
              data-testid="button-delete-topic-confirm"
            >
              {deleteTopicMutation.isPending ? 'Deleting...' : 'Yes, delete topic'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {quarantineOpen && (
        <Suspense fallback={null}>
          <OutletOversightDialog
            open={quarantineOpen}
            onOpenChange={(v) => { setQuarantineOpen(v); if (!v) setOversightInitialTab(undefined); }}
            initialTab={oversightInitialTab}
          />
        </Suspense>
      )}

      <Dialog open={ftDialogOpen} onOpenChange={(open) => {
        setFtDialogOpen(open);
        if (!open) {
          setFtAnalysis(null);
          setFtXUrl('');
          setFtScreenshotFile(null);
          setFtScreenshotPreview(null);
          setFtEditAccount('');
          setFtEditContent('');
          setFtEditPostedAt('');
          setFtEditImageUrl('');
        }
      }}>
        <DialogContent className="sm:max-w-[700px] max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2" data-testid="flight-tracking-dialog-title">
              <MapPin className="h-5 w-5" />
              Upload Flight Tracking Post
            </DialogTitle>
          </DialogHeader>
          
          <div className="flex-1 overflow-y-auto space-y-4 pr-1">
            <div className="space-y-3">
              <div>
                <Label className="text-xs font-medium">X Post URL</Label>
                <Input
                  placeholder="https://x.com/username/status/..."
                  value={ftXUrl}
                  onChange={(e) => setFtXUrl(e.target.value)}
                  data-testid="input-ft-url"
                />
              </div>
              
              <div>
                <Label className="text-xs font-medium">Screenshot</Label>
                <div className="mt-1 space-y-2">
                  <input
                    ref={ftFileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleFtScreenshotSelect(file);
                    }}
                    data-testid="input-ft-screenshot"
                  />
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => ftFileInputRef.current?.click()}
                      data-testid="button-ft-select-file"
                    >
                      <FolderInput className="w-4 h-4 mr-2" />
                      Select File
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {ftScreenshotFile ? ftScreenshotFile.name : 'Or paste from clipboard (Ctrl+V)'}
                    </span>
                  </div>
                  {ftScreenshotPreview && (
                    <div className="relative">
                      <img
                        src={ftScreenshotPreview}
                        alt="Screenshot preview"
                        className="max-h-48 rounded-md border"
                        data-testid="img-ft-screenshot-preview"
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="absolute top-1 right-1"
                        onClick={() => {
                          setFtScreenshotFile(null);
                          setFtScreenshotPreview(null);
                        }}
                        data-testid="button-ft-remove-screenshot"
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              <Button
                onClick={handleFtAnalyze}
                disabled={!ftScreenshotFile || !ftXUrl || ftAnalyzing}
                data-testid="button-ft-analyze"
              >
                {ftAnalyzing ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Analyzing...
                  </>
                ) : (
                  <>
                    <Search className="w-4 h-4 mr-2" />
                    Analyze Screenshot
                  </>
                )}
              </Button>
            </div>

            {ftAnalysis && (
              <div className="space-y-4 border-t pt-4">
                <h3 className="text-sm font-semibold">Extracted Data (editable)</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs font-medium">Account Handle</Label>
                    <Input
                      value={ftEditAccount}
                      onChange={(e) => setFtEditAccount(e.target.value)}
                      data-testid="input-ft-edit-account"
                    />
                  </div>
                  <div>
                    <Label className="text-xs font-medium">Posted At</Label>
                    <Input
                      type="datetime-local"
                      value={ftEditPostedAt ? new Date(ftEditPostedAt).toISOString().slice(0, 16) : ''}
                      onChange={(e) => setFtEditPostedAt(new Date(e.target.value).toISOString())}
                      data-testid="input-ft-edit-time"
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-xs font-medium">Post Content</Label>
                  <Textarea
                    value={ftEditContent}
                    onChange={(e) => setFtEditContent(e.target.value)}
                    rows={5}
                    className="resize-none font-mono text-xs"
                    data-testid="input-ft-edit-content"
                  />
                  {ftAnalysis.isRetweet && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Quote-tweet detected from @{ftAnalysis.retweetedFrom}. Content includes both commentary and original text.
                    </p>
                  )}
                </div>

                <div>
                  <Label className="text-xs font-medium">
                    Post Image URL {ftAnalysis.hasEmbeddedImage && <span className="text-muted-foreground">(image detected: {ftAnalysis.imageDescription})</span>}
                  </Label>
                  <Input
                    placeholder="Paste the image URL from the X post (right-click image → Copy image address)"
                    value={ftEditImageUrl}
                    onChange={(e) => setFtEditImageUrl(e.target.value)}
                    data-testid="input-ft-edit-image-url"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    {ftAnalysis.hasEmbeddedImage
                      ? 'Open the X post, right-click the image, and paste the URL here to display the image instead of the screenshot.'
                      : 'Optional. Leave blank to use the screenshot image.'}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <h4 className="text-xs font-semibold mb-2 text-muted-foreground">Main Page Preview</h4>
                    <Card className="p-3">
                      <div className="space-y-2">
                        <div className="flex items-start gap-2">
                          <div className="flex-shrink-0">
                            <div className="h-8 w-8 rounded-full bg-emerald-600 flex items-center justify-center text-white text-xs font-bold">
                              FT
                            </div>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <div>
                                <div className="text-xs font-semibold" data-testid="text-ft-preview-account">
                                  @{ftEditAccount}
                                </div>
                                <div className="text-xs text-muted-foreground font-mono" data-testid="text-ft-preview-time">
                                  {ftEditPostedAt ? new Date(ftEditPostedAt).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : ''}
                                </div>
                              </div>
                              <ExternalLink className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                            </div>
                          </div>
                        </div>
                        <div className="text-sm leading-relaxed" data-testid="text-ft-preview-content">
                          {ftEditContent.split('\n').map((line, i) => {
                            if (line.startsWith('RT @')) {
                              return <span key={i} className="block mt-2 text-xs text-muted-foreground italic border-l-2 border-muted pl-2">{line}</span>;
                            }
                            return <span key={i} className="block">{line}</span>;
                          })}
                        </div>
                      </div>
                    </Card>
                  </div>

                  <div>
                    <h4 className="text-xs font-semibold mb-2 text-muted-foreground">Stream Page Preview</h4>
                    <div className="bg-slate-800/50 rounded-xl overflow-hidden border border-slate-700/50">
                      <div className="p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center text-white font-bold text-xs">
                            F
                          </div>
                          <div>
                            <div className="text-xs font-bold text-white" data-testid="text-ft-stream-preview-account">@{ftEditAccount}</div>
                            <div className="text-[10px] text-slate-400">
                              {ftEditPostedAt ? new Date(ftEditPostedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : ''}
                            </div>
                          </div>
                        </div>
                        <div className="text-sm text-slate-200 leading-relaxed" data-testid="text-ft-stream-preview-content">
                          {ftEditContent.split('\n').map((line, i) => {
                            if (line.startsWith('RT @')) {
                              return <span key={i} className="block mt-2 text-xs text-slate-400 italic border-l-2 border-slate-600 pl-2">{line}</span>;
                            }
                            return <span key={i} className="block">{line}</span>;
                          })}
                        </div>
                      </div>
                      {(ftEditImageUrl || ftAnalysis.screenshotUrl) && (
                        <div className="px-3 pb-3">
                          <img
                            src={ftEditImageUrl || ftAnalysis.screenshotUrl}
                            alt="Post image"
                            className="w-full rounded-lg"
                            onError={(e) => {
                              if (ftEditImageUrl && ftAnalysis.screenshotUrl) {
                                (e.target as HTMLImageElement).src = ftAnalysis.screenshotUrl;
                              }
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setFtAnalysis(null);
                      setFtEditAccount('');
                      setFtEditContent('');
                      setFtEditPostedAt('');
                      setFtEditImageUrl('');
                    }}
                    data-testid="button-ft-reset"
                  >
                    <RotateCcw className="w-4 h-4 mr-2" />
                    Reset
                  </Button>
                  <Button
                    onClick={handleFtSave}
                    disabled={ftSaving || !ftEditContent || !ftEditAccount}
                    data-testid="button-ft-save"
                  >
                    {ftSaving ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Send className="w-4 h-4 mr-2" />
                        Save Post
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={manageTeamOpen} onOpenChange={setManageTeamOpen}>
        <DialogContent className="sm:max-w-[500px] max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2" data-testid="manage-team-dialog-title">
              <Users className="h-5 w-5" />
              Manage Team Members
            </DialogTitle>
          </DialogHeader>
          
          <div className="flex-1 overflow-hidden flex flex-col gap-4">
            <div className="flex gap-2">
              <Input
                placeholder="Enter email address..."
                value={newMemberEmail}
                onChange={(e) => setNewMemberEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newMemberEmail.trim()) {
                    e.preventDefault();
                    addTeamMemberMutation.mutate(newMemberEmail.trim());
                  }
                }}
                data-testid="input-new-member-email"
              />
              <Button
                onClick={() => {
                  if (newMemberEmail.trim()) {
                    addTeamMemberMutation.mutate(newMemberEmail.trim());
                  }
                }}
                disabled={!newMemberEmail.trim() || addTeamMemberMutation.isPending}
                data-testid="button-add-member"
              >
                {addTeamMemberMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
              </Button>
            </div>
            
            <div className="flex-1 overflow-y-auto border rounded-md">
              {teamMembersLoading ? (
                <div className="flex items-center justify-center p-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : teamMembersData.length === 0 ? (
                <div className="text-center text-muted-foreground p-8">
                  No team members yet
                </div>
              ) : (
                <div className="divide-y">
                  {teamMembersData.map((member) => (
                    <div
                      key={member.id}
                      className="flex items-center justify-between p-3 hover-elevate"
                      data-testid={`team-member-${member.id}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">{member.email}</div>
                        <div className="text-xs text-muted-foreground">
                          Added by {member.addedBy} on {format(new Date(member.addedAt), 'MMM d, yyyy')}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeTeamMemberMutation.mutate(member.id)}
                        disabled={removeTeamMemberMutation.isPending}
                        data-testid={`button-remove-member-${member.id}`}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            
            <p className="text-xs text-muted-foreground">
              Add team members by their Replit account email address. They will be able to access the Team page after logging in.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {smsAlertsOpen && (
        <Suspense fallback={null}>
          <SmsAlertsDialog open={smsAlertsOpen} onOpenChange={setSmsAlertsOpen} />
        </Suspense>
      )}

      {relayMonitorOpen && (
        <Suspense fallback={null}>
          <RelayTestPostsDialog open={relayMonitorOpen} onOpenChange={setRelayMonitorOpen} />
        </Suspense>
      )}


      {reviewDialogOpen && (
        <Suspense fallback={null}>
          <ReviewSubmissionDialog
            open={reviewDialogOpen}
            onOpenChange={(open) => {
              setReviewDialogOpen(open);
              if (!open) {
                reviewAbortRef.current?.abort();
                setReviewData(null);
                setPendingReviewMessage("");
              }
            }}
            reviewData={reviewData}
            existingTopics={allTopics}
            onSave={handleReviewSave}
            isSaving={sendMessageMutation.isPending}
          />
        </Suspense>
      )}

      {xPostReviewOpen && (
        <Suspense fallback={null}>
          <ReviewXPostDialog
            open={xPostReviewOpen}
            onOpenChange={(open) => {
              setXPostReviewOpen(open);
              if (!open) {
                setXPostReviewData(null);
                setPendingXPostMessage("");
              }
            }}
            xPostData={xPostReviewData}
            onSave={handleXPostReviewSave}
            isSaving={xPostSaving || sendMessageMutation.isPending}
          />
        </Suspense>
      )}

      {quoteDatabaseOpen && (
        <Suspense fallback={null}>
          <QuoteDatabaseDialog
            open={quoteDatabaseOpen}
            onOpenChange={setQuoteDatabaseOpen}
          />
        </Suspense>
      )}

    </div>
  );
}
