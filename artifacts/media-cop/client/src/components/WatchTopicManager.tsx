// Priority / BOLO watch-topic management (Task #1094).
// Single home for creating, editing, reordering, archiving/restoring, and
// deleting watch topics, plus an influence panel showing how steering nudges
// curated scoring. Extracted from the Team page (which now shows a compact
// pointer here). All mutations reuse the existing
// /api/team/joe-priorities-bolo endpoints and cache keys — no behavior change.
import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Card } from "@/components/ui/card";
import {
  Loader2, Plus, Search, X, ChevronDown, ChevronRight, Trash2, RotateCcw, Settings2, Gauge, Radar,
} from "lucide-react";
import { TopicSelectItems } from "@/lib/topicOrdering";
import { PRIMARY_TOPICS, OTHER_EMERGING } from "@shared/classificationVocab";

// Shapes returned by /api/team/joe-priorities-bolo (mirrors the Team page's
// local interfaces — the API payload is shared).
export interface WatchSubmission {
  id: string;
  sourceType: string;
  sourceUrl: string;
  sourceName: string | null;
  headline: string;
  publishedAt: string | null;
  createdAt: string;
}

export interface WatchSubject {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  topicId: string | null;
  focusArea: string | null;
  submissions: WatchSubmission[];
  totalCount: number;
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

export interface JoePriorityBoloResponse {
  joePriorities: WatchSubject[];
  archivedJoePriorities: WatchSubject[];
  boloItems: WatchSubject[];
  archivedBoloItems: WatchSubject[];
}

// Compact metrics + Topic/Focus classification shown inside each expanded
// Priority / BOLO card.
export function WatchTopicMeta({
  subject,
  allTopics,
  onSaveTopic,
  onSaveFocus,
  saving,
}: {
  subject: WatchSubject;
  allTopics: Array<{ id: string; name: string }>;
  onSaveTopic: (id: string, topicId: string | null) => void;
  onSaveFocus: (id: string, focusArea: string | null) => void;
  saving: boolean;
}) {
  const RECENT_DAYS = 7;
  const total = subject.submissions.length;
  const cutoff = Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000;
  const recent = subject.submissions.filter((s) => {
    const t = new Date((s.publishedAt as any) || s.createdAt).getTime();
    return Number.isFinite(t) && t >= cutoff;
  }).length;
  const implemented = subject.createdAt ? format(new Date(subject.createdAt), 'MMM d, yyyy') : '—';
  const [focusDraft, setFocusDraft] = useState(subject.focusArea || '');

  const commitFocus = () => {
    const next = focusDraft.trim();
    if (next === (subject.focusArea || '')) return;
    onSaveFocus(subject.id, next || null);
  };

  return (
    <div className="pt-1 space-y-1.5">
      <div
        className="flex items-center flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground"
        data-testid={`text-metrics-${subject.id}`}
      >
        <span>Added {implemented}</span>
        <span aria-hidden>·</span>
        <span><span className="font-semibold text-foreground">{total}</span> identified</span>
        <span aria-hidden>·</span>
        <span><span className="font-semibold text-foreground">{recent}</span> in last {RECENT_DAYS}d</span>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <Select
          value={subject.topicId || ''}
          onValueChange={(val) => onSaveTopic(subject.id, val || null)}
        >
          <SelectTrigger className="h-7 w-[140px] text-[11px]" data-testid={`select-topic-${subject.id}`}>
            <SelectValue placeholder="Set topic" />
          </SelectTrigger>
          <SelectContent>
            <TopicSelectItems topics={allTopics} />
          </SelectContent>
        </Select>
        <Input
          value={focusDraft}
          onChange={(e) => setFocusDraft(e.target.value)}
          onBlur={commitFocus}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="Focus area"
          disabled={saving}
          className="h-7 text-[11px] flex-1 min-w-[110px]"
          data-testid={`input-focus-${subject.id}`}
        />
      </div>
    </div>
  );
}

// ─── Watch Topic Detail Dialog ───────────────────────────────────────────────
// Full popup showing and editing all detail fields for a Priority / BOLO topic.

export function KeywordBox({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const tokens = draft.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length >= 1);
    const next = Array.from(new Set([...value, ...tokens])).slice(0, 12);
    onChange(next);
    setDraft('');
  };

  return (
    <div className="space-y-1">
      <div>
        <div className="text-xs font-medium">{label}</div>
        <div className="text-[10px] text-muted-foreground">{description}</div>
      </div>
      <div className="flex flex-wrap gap-1 min-h-[28px] border rounded-md p-1.5">
        {value.map((kw) => (
          <Badge key={kw} variant="secondary" className="text-[10px] gap-1 pr-0.5">
            {kw}
            <button
              onClick={() => onChange(value.filter(k => k !== kw))}
              className="ml-0.5 opacity-60 hover:opacity-100"
              data-testid={`button-remove-kw-${kw}`}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </Badge>
        ))}
        <input
          className="flex-1 min-w-[120px] bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/60"
          placeholder="Add term, phrase… Enter or comma"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
            if (e.key === 'Backspace' && !draft && value.length > 0) onChange(value.slice(0, -1));
          }}
          data-testid={`input-kw-${label.toLowerCase().replace(/\s+/g, '-')}`}
        />
      </div>
    </div>
  );
}

export function WatchTopicDetailDialog({
  subject,
  open,
  onOpenChange,
  allTopics,
  onSaved,
}: {
  subject: WatchSubject;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  allTopics: Array<{ id: string; name: string }>;
  onSaved: () => void;
}) {
  const { toast } = useToast();

  // Local editable state — initialized from the subject, reset on open.
  const [name, setName] = useState(subject.name);
  const [description, setDescription] = useState(subject.description || '');
  const [lifecycleMode, setLifecycleMode] = useState<'smart_decay' | 'hold'>(
    (subject.lifecycleMode as any) || 'smart_decay'
  );
  const [boostStrength, setBoostStrength] = useState<'weak' | 'standard' | 'strong'>(
    (subject.boostStrength as any) || 'standard'
  );
  const [orKeywords, setOrKeywords] = useState<string[]>(subject.orKeywords || []);
  const [andKeywords, setAndKeywords] = useState<string[]>(subject.andKeywords || []);
  const [notKeywords, setNotKeywords] = useState<string[]>(subject.notKeywords || []);
  const [watchTopicLabel, setWatchTopicLabel] = useState(subject.watchTopicLabel || '');
  const [focusArea, setFocusArea] = useState(subject.focusArea || '');
  const [expiryStr, setExpiryStr] = useState(
    subject.estimatedActiveUntil
      ? format(new Date(subject.estimatedActiveUntil), 'yyyy-MM-dd')
      : ''
  );
  const [saving, setSaving] = useState(false);

  // Reset on subject change.
  useEffect(() => {
    setName(subject.name);
    setDescription(subject.description || '');
    setLifecycleMode((subject.lifecycleMode as any) || 'smart_decay');
    setBoostStrength((subject.boostStrength as any) || 'standard');
    setOrKeywords(subject.orKeywords || []);
    setAndKeywords(subject.andKeywords || []);
    setNotKeywords(subject.notKeywords || []);
    setWatchTopicLabel(subject.watchTopicLabel || '');
    setFocusArea(subject.focusArea || '');
    setExpiryStr(subject.estimatedActiveUntil ? format(new Date(subject.estimatedActiveUntil), 'yyyy-MM-dd') : '');
  }, [subject.id]);

  // Impact stats query (lazy — only when dialog is open).
  const statsQuery = useQuery<{ avgMatchesPerDay: number; avgBaseScore: number; currentBoostStrength: string }>({
    queryKey: ['/api/team/joe-priorities-bolo', subject.id, 'stats'],
    queryFn: async () => {
      const res = await fetch(`/api/team/joe-priorities-bolo/${subject.id}/stats`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load stats');
      return res.json();
    },
    enabled: open,
    staleTime: 60000,
  });

  const handleSave = async () => {
    if (!name.trim()) { toast({ title: 'Name is required', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim() || null,
        watchTopicLabel: watchTopicLabel || null,
        lifecycleMode,
        boostStrength,
        orKeywords,
        andKeywords,
        notKeywords,
        focusArea: focusArea.trim() || null,
      };
      if (expiryStr) {
        const d = new Date(expiryStr);
        if (!isNaN(d.getTime())) body.estimatedActiveUntil = d.toISOString();
      } else {
        body.estimatedActiveUntil = null;
      }
      const res = await apiRequest('PATCH', `/api/team/joe-priorities-bolo/${subject.id}`, body);
      if (!res.ok) throw new Error('Save failed');
      onSaved();
      toast({ title: 'Topic updated' });
      onOpenChange(false);
    } catch {
      toast({ title: 'Failed to save', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const isLegacyKeywords = (subject.watchKeywords || []).length > 0;
  const expiry = subject.estimatedActiveUntil ? new Date(subject.estimatedActiveUntil) : null;
  const daysLeft = expiry ? Math.round((expiry.getTime() - Date.now()) / 86400_000) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto" data-testid="dialog-watch-topic-detail">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <span className="truncate">{subject.name}</span>
            {subject.isPriorityWatch && <Badge variant="outline" className="text-[10px] text-blue-600 dark:text-blue-400 border-blue-300 dark:border-blue-700">Priority</Badge>}
            {subject.isBoloWatch && <Badge variant="outline" className="text-[10px] text-orange-600 dark:text-orange-400 border-orange-300 dark:border-orange-700">BOLO</Badge>}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Edit name, description, keyword filters, lifecycle, and boost strength.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Impact stats */}
          <div className="grid grid-cols-3 gap-2">
            {[
              {
                label: 'Matches (30d)',
                value: statsQuery.isLoading ? '…' : statsQuery.data ? `${(statsQuery.data.avgMatchesPerDay * 30).toFixed(0)}` : '—',
                sub: statsQuery.data ? `${statsQuery.data.avgMatchesPerDay.toFixed(1)}/day` : undefined,
                testid: 'stat-matches',
              },
              {
                label: 'Avg Base Score',
                value: statsQuery.isLoading ? '…' : statsQuery.data ? `${statsQuery.data.avgBaseScore}` : '—',
                sub: 'before boost',
                testid: 'stat-avg-score',
              },
              {
                label: 'Expiry',
                value: expiry ? format(expiry, 'MMM d, yyyy') : 'None',
                sub: daysLeft != null ? (daysLeft <= 0 ? 'Expired' : `${daysLeft}d left`) : undefined,
                testid: 'stat-expiry',
              },
            ].map(s => (
              <div key={s.label} className="border rounded-md p-2 text-center" data-testid={s.testid}>
                <div className="text-[10px] text-muted-foreground">{s.label}</div>
                <div className="text-base font-semibold tabular-nums">{s.value}</div>
                {s.sub && <div className="text-[10px] text-muted-foreground">{s.sub}</div>}
              </div>
            ))}
          </div>

          {/* Name + description */}
          <div className="space-y-2">
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={200}
                className="text-sm"
                data-testid="input-watch-name"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Description</Label>
              <Textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                maxLength={2000}
                rows={2}
                className="text-xs resize-none"
                placeholder="What to watch for…"
                data-testid="textarea-watch-description"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Original prompt <span className="text-muted-foreground font-normal">(provenance — read-only)</span></Label>
              <div
                className="text-xs text-muted-foreground rounded-md border bg-muted/30 px-3 py-2 min-h-[48px] whitespace-pre-wrap"
                data-testid="text-source-prompt"
              >
                {subject.sourcePrompt || <span className="italic">Prompt not recorded</span>}
              </div>
            </div>
          </div>

          {/* Topic + Focus */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Curated Topic</Label>
              <Select
                value={watchTopicLabel || '__none__'}
                onValueChange={(v) => setWatchTopicLabel(v === '__none__' ? '' : v)}
              >
                <SelectTrigger className="h-8 text-xs" data-testid="select-topic-detail">
                  <SelectValue placeholder="Set topic" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {[...PRIMARY_TOPICS, OTHER_EMERGING].map(t => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Focus Area</Label>
              <Input
                value={focusArea}
                onChange={e => setFocusArea(e.target.value)}
                maxLength={80}
                placeholder="e.g. Indo-Pacific Deterrence"
                className="h-8 text-xs"
                data-testid="input-focus-area-detail"
              />
            </div>
          </div>

          {/* Keyword boxes */}
          <div className="space-y-3">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Keyword Filters</div>
            {isLegacyKeywords && (
              <div className="text-[10px] text-muted-foreground bg-muted/40 rounded-md px-2 py-1.5">
                Legacy AI keywords: {(subject.watchKeywords || []).join(', ')}. Use the boxes below to override matching behavior.
              </div>
            )}
            <KeywordBox
              label="OR Keywords"
              description="Match if ANY term appears — widens coverage"
              value={orKeywords}
              onChange={setOrKeywords}
            />
            <KeywordBox
              label="AND Keywords"
              description="ALL of these must appear — narrows to precise context"
              value={andKeywords}
              onChange={setAndKeywords}
            />
            <KeywordBox
              label="NOT Keywords"
              description="Exclude articles containing ANY of these"
              value={notKeywords}
              onChange={setNotKeywords}
            />
          </div>

          {/* Lifecycle + Boost */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Lifecycle Mode</Label>
              <Select value={lifecycleMode} onValueChange={v => setLifecycleMode(v as any)}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-lifecycle">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="smart_decay">Smart Decay — auto-extend if active</SelectItem>
                  <SelectItem value="hold">Hold — never auto-archive</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">
                {lifecycleMode === 'hold'
                  ? 'Topic stays active indefinitely; archive manually.'
                  : 'Topic auto-extends when it\'s still being matched near its expiry.'}
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Boost Strength</Label>
              <Select value={boostStrength} onValueChange={v => setBoostStrength(v as any)}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-boost">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="weak">Weak (+8 pts, floor 60)</SelectItem>
                  <SelectItem value="standard">Standard (+15 pts, floor 66)</SelectItem>
                  <SelectItem value="strong">Strong (+22 pts, floor 72)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">How aggressively matching articles are promoted in the curated feed.</p>
            </div>
          </div>

          {/* Expiry date */}
          <div className="space-y-1">
            <Label className="text-xs">Watch Until <span className="text-muted-foreground font-normal">(optional — leave blank for no expiry)</span></Label>
            <Input
              type="date"
              value={expiryStr}
              onChange={e => setExpiryStr(e.target.value)}
              className="h-8 text-xs w-48"
              data-testid="input-expiry-date"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-detail">Cancel</Button>
          <Button onClick={handleSave} disabled={saving} data-testid="button-save-detail">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Full management panel ───────────────────────────────────────────────────
// Rendered inside the Source Oversight "Priority / BOLO" tab. Self-contained:
// owns all queries/mutations against the existing endpoints and cache keys.

type JoeSortMode = 'manual' | 'recent' | 'alpha';

export function WatchTopicManager({ enabled = true }: { enabled?: boolean }) {
  const { toast } = useToast();

  const { data: joePriorityData, isLoading: joePriorityLoading } = useQuery<JoePriorityBoloResponse>({
    queryKey: ['/api/team/joe-priorities-bolo'],
    refetchInterval: 60000,
    staleTime: 30000,
    enabled,
  });

  const { data: allTopics = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['/api/team/topics'],
    enabled,
  });

  // Curated steering toggle (Priority boost + BOLO rescue in the curated lane).
  const { data: watchTopicSteeringStatus } = useQuery<{ enabled: boolean }>({
    queryKey: ['/api/watch-topic-steering/enabled'],
    enabled,
  });
  const watchTopicSteeringEnabled = watchTopicSteeringStatus?.enabled ?? false;

  const toggleWatchTopicSteeringMutation = useMutation({
    mutationFn: async (on: boolean) => {
      return apiRequest('POST', '/api/watch-topic-steering/toggle', { enabled: on });
    },
    onSuccess: (_data, on) => {
      queryClient.invalidateQueries({ queryKey: ['/api/watch-topic-steering/enabled'] });
      toast({ title: on ? 'Watch steering on' : 'Watch steering off' });
    },
    onError: () => {
      toast({ title: 'Failed to update watch steering', variant: 'destructive' });
    },
  });

  // Independent AI-tagging matcher toggle (tags matching Team submissions —
  // separate system from curated steering; affects the Team page, not scoring).
  const { data: joePriorityMatchingStatus } = useQuery<{ enabled: boolean }>({
    queryKey: ['/api/joe-priority-matching/enabled'],
    enabled,
  });
  const joePriorityMatchingEnabled = joePriorityMatchingStatus?.enabled ?? true;

  const toggleJoePriorityMatchingMutation = useMutation({
    mutationFn: async (on: boolean) => {
      return apiRequest('POST', '/api/joe-priority-matching/toggle', { enabled: on });
    },
    onSuccess: (_data, on) => {
      queryClient.invalidateQueries({ queryKey: ['/api/joe-priority-matching/enabled'] });
      toast({ title: on ? 'Auto-matching resumed' : 'Auto-matching paused' });
    },
    onError: () => {
      toast({ title: 'Failed to update auto-matching', variant: 'destructive' });
    },
  });

  // Sort mode — same localStorage key the Team page used, so the preference
  // carries over.
  const [joePrioritySortMode, setJoePrioritySortMode] = useState<JoeSortMode>(() => {
    if (typeof window === 'undefined') return 'recent';
    const saved = window.localStorage.getItem('joePrioritySortMode');
    return saved === 'manual' || saved === 'recent' || saved === 'alpha' ? saved : 'recent';
  });
  const updateJoePrioritySortMode = (mode: JoeSortMode) => {
    setJoePrioritySortMode(mode);
    try { window.localStorage.setItem('joePrioritySortMode', mode); } catch {}
  };

  const latestSubmissionTime = (submissions?: WatchSubmission[]) => {
    if (!submissions || submissions.length === 0) return 0;
    return submissions.reduce((max, sub) => {
      const t = new Date(sub.publishedAt || sub.createdAt).getTime() || 0;
      return t > max ? t : max;
    }, 0);
  };
  const sortJoeTopics = (topics: WatchSubject[]): WatchSubject[] => {
    const list = [...topics];
    if (joePrioritySortMode === 'alpha') {
      list.sort((a, b) => a.name.localeCompare(b.name));
    } else if (joePrioritySortMode === 'recent') {
      list.sort((a, b) => latestSubmissionTime(b.submissions) - latestSubmissionTime(a.submissions));
    }
    return list;
  };
  const sortedJoePriorities = sortJoeTopics(joePriorityData?.joePriorities || []);
  const sortedBoloItems = sortJoeTopics(joePriorityData?.boloItems || []);

  // Recent/older split for the expanded matched-article lists.
  const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
  const splitByAge = (submissions: WatchSubmission[]) => {
    const cutoff = Date.now() - TWELVE_HOURS_MS;
    const recent: WatchSubmission[] = [];
    const old: WatchSubmission[] = [];
    submissions.forEach(sub => {
      const t = new Date(sub.publishedAt || sub.createdAt).getTime();
      if (t >= cutoff) recent.push(sub); else old.push(sub);
    });
    return { recent, old };
  };
  const jpSplitByAgeMap = useMemo(() => {
    const map = new Map<string, { recent: WatchSubmission[]; old: WatchSubmission[] }>();
    (joePriorityData?.joePriorities ?? []).forEach(subject => {
      map.set(subject.id, splitByAge(subject.submissions));
    });
    return map;
  }, [joePriorityData?.joePriorities]);
  const boloSplitByAgeMap = useMemo(() => {
    const map = new Map<string, { recent: WatchSubmission[]; old: WatchSubmission[] }>();
    (joePriorityData?.boloItems ?? []).forEach(subject => {
      map.set(subject.id, splitByAge(subject.submissions));
    });
    return map;
  }, [joePriorityData?.boloItems]);

  // UI state
  const [watchText, setWatchText] = useState('');
  const [watchPriority, setWatchPriority] = useState(true);
  const [watchBolo, setWatchBolo] = useState(false);
  const [watchSubmitting, setWatchSubmitting] = useState(false);
  const [watchUrl, setWatchUrl] = useState('');
  const [similarLoading, setSimilarLoading] = useState(false);
  const [similarResult, setSimilarResult] = useState<{ title: string; matches: Array<{ id: string; title: string; displayTitle: string; source: string; url: string; similarity: number }> } | null>(null);
  const [olderPrioritiesExpanded, setOlderPrioritiesExpanded] = useState(false);
  const [expandedSubjects, setExpandedSubjects] = useState<Set<string>>(new Set());
  const [expandedOldSections, setExpandedOldSections] = useState<Set<string>>(new Set());
  const [detailSubject, setDetailSubject] = useState<WatchSubject | null>(null);
  const [influenceOpen, setInfluenceOpen] = useState(false);

  const toggleSubject = (key: string) => setExpandedSubjects(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleOldSection = (key: string) => setExpandedOldSections(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // Mutations — identical endpoints + cache keys as before.
  const createJoePriorityMutation = useMutation({
    mutationFn: async ({ text, isPriorityWatch, isBoloWatch }: { text: string; isPriorityWatch: boolean; isBoloWatch: boolean }) => {
      const res = await apiRequest('POST', '/api/team/joe-priorities-bolo', { text, isPriorityWatch, isBoloWatch, topicId: null });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/joe-priorities-bolo'] });
      toast({ title: 'Watch topic created' });
    },
    onError: (error: Error) => {
      const msg = error?.message || '';
      const status = Number(msg.match(/^(\d{3}):/)?.[1]) || 0;
      let reason: string | undefined;
      let serverMessage: string | undefined;
      const jsonStart = msg.indexOf('{');
      if (jsonStart !== -1) {
        try {
          const body = JSON.parse(msg.slice(jsonStart));
          reason = body?.reason;
          serverMessage = body?.error;
        } catch {
          /* fall through to status-based defaults */
        }
      }
      if (reason === 'transient' || status === 503) {
        toast({ title: 'AI is busy', description: serverMessage || 'Please try again in a moment.', variant: 'destructive' });
      } else if (reason === 'could_not_extract' || status === 422) {
        toast({ title: "Couldn't understand that text", description: serverMessage || 'Try rephrasing what to watch for.', variant: 'destructive' });
      } else {
        toast({ title: 'Failed to create topics', description: serverMessage || undefined, variant: 'destructive' });
      }
    },
  });

  const updateWatchClassificationMutation = useMutation({
    mutationFn: async ({ id, topicId, focusArea }: { id: string; topicId?: string | null; focusArea?: string | null }) => {
      const body: { topicId?: string | null; focusArea?: string | null } = {};
      if (topicId !== undefined) body.topicId = topicId;
      if (focusArea !== undefined) body.focusArea = focusArea;
      const res = await apiRequest('PATCH', `/api/team/joe-priorities-bolo/${id}/classification`, body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/joe-priorities-bolo'] });
    },
    onError: () => {
      toast({ title: 'Failed to update classification', variant: 'destructive' });
    },
  });

  const deleteJoePriorityMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest('DELETE', `/api/team/joe-priorities-bolo/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/joe-priorities-bolo'] });
      toast({ title: 'Watch topic deleted' });
    },
    onError: () => {
      toast({ title: 'Failed to delete', variant: 'destructive' });
    },
  });

  const archiveJoePriorityMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest('PATCH', `/api/team/joe-priorities-bolo/${id}/archive`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/joe-priorities-bolo'] });
      toast({ title: 'Priority moved to Older Priorities' });
    },
  });

  const restoreJoePriorityMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest('PATCH', `/api/team/joe-priorities-bolo/${id}/restore`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/joe-priorities-bolo'] });
      toast({ title: 'Priority restored' });
    },
  });

  const reorderJoePriorityMutation = useMutation({
    mutationFn: async (items: Array<{ id: string }>) => {
      const res = await apiRequest('PATCH', '/api/team/joe-priorities-bolo/reorder', { items });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/team/joe-priorities-bolo'] });
    },
  });

  const handleWatchSubmit = async () => {
    if (!watchText.trim() || (!watchPriority && !watchBolo)) return;
    setWatchSubmitting(true);
    try {
      await createJoePriorityMutation.mutateAsync({ text: watchText, isPriorityWatch: watchPriority, isBoloWatch: watchBolo });
      setWatchText('');
      setWatchUrl('');
      setSimilarResult(null);
    } finally {
      setWatchSubmitting(false);
    }
  };

  const checkSimilarArticles = async () => {
    const url = watchUrl.trim();
    if (!url) return;
    setSimilarLoading(true);
    setSimilarResult(null);
    try {
      const res = await apiRequest('GET', `/api/team/watch-topics/similar?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      setSimilarResult({ title: data.title || '', matches: Array.isArray(data.matches) ? data.matches : [] });
    } catch (e: any) {
      toast({ title: 'Could not check that link', description: e?.message, variant: 'destructive' });
    } finally {
      setSimilarLoading(false);
    }
  };

  const handleMoveUp = (items: WatchSubject[], index: number) => {
    if (index === 0) return;
    const newItems = [...items];
    [newItems[index - 1], newItems[index]] = [newItems[index], newItems[index - 1]];
    reorderJoePriorityMutation.mutate(newItems.map(item => ({ id: item.id })));
  };

  const handleMoveDown = (items: WatchSubject[], index: number) => {
    if (index === items.length - 1) return;
    const newItems = [...items];
    [newItems[index], newItems[index + 1]] = [newItems[index + 1], newItems[index]];
    reorderJoePriorityMutation.mutate(newItems.map(item => ({ id: item.id })));
  };

  const priorityCount = joePriorityData?.joePriorities?.length || 0;
  const boloCount = joePriorityData?.boloItems?.length || 0;
  const archivedCount = (joePriorityData?.archivedJoePriorities?.length || 0) + (joePriorityData?.archivedBoloItems?.length || 0);

  const renderTopicCard = (subject: WatchSubject, kind: 'jp' | 'bolo', index: number, list: WatchSubject[]) => {
    const key = `${kind}-${subject.id}`;
    const split = (kind === 'jp' ? jpSplitByAgeMap : boloSplitByAgeMap).get(subject.id) ?? { recent: [], old: [] };
    const oldKey = `${kind}-old-${subject.id}`;
    return (
      <Collapsible
        key={key}
        open={expandedSubjects.has(key)}
        onOpenChange={() => toggleSubject(key)}
      >
        <Card className="mb-1">
          <div className="flex items-center justify-between gap-1 p-2">
            {joePrioritySortMode === 'manual' && (
              <div className="flex flex-col gap-0.5">
                <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => handleMoveUp(list, index)} disabled={index === 0} data-testid={`button-move-up-${kind}-${subject.id}`}>
                  <ChevronDown className="h-3 w-3 rotate-180" />
                </Button>
                <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => handleMoveDown(list, index)} disabled={index === list.length - 1} data-testid={`button-move-down-${kind}-${subject.id}`}>
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </div>
            )}
            <CollapsibleTrigger asChild>
              <button
                className="flex-shrink-0 p-0.5 hover-elevate rounded"
                data-testid={`${kind}-trigger-${subject.id}`}
              >
                {expandedSubjects.has(key) ? (
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                )}
              </button>
            </CollapsibleTrigger>
            <button
              className="flex-1 min-w-0 text-left"
              onClick={() => setDetailSubject(subject)}
              data-testid={`button-open-${kind}-${subject.id}`}
            >
              <div className="flex items-center gap-2 hover-elevate rounded px-1">
                <span className="font-medium text-xs truncate">{subject.name}</span>
                {(() => {
                  const count = kind === 'jp' ? split.recent.length : subject.totalCount;
                  return count > 0 ? (
                    <Badge variant="outline" className="text-xs flex-shrink-0">{count}</Badge>
                  ) : null;
                })()}
              </div>
            </button>
            <Button
              size="icon"
              variant="ghost"
              onClick={(e) => { e.stopPropagation(); setDetailSubject(subject); }}
              title="Edit topic details"
              data-testid={`button-detail-${kind}-${subject.id}`}
            >
              <Settings2 className="h-3 w-3 text-muted-foreground" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={(e) => { e.stopPropagation(); archiveJoePriorityMutation.mutate(subject.id); }}
              data-testid={`button-archive-${kind}-${subject.id}`}
            >
              <Trash2 className="h-3 w-3 text-muted-foreground" />
            </Button>
          </div>
          <CollapsibleContent>
            <div className="border-t px-2 pb-2 space-y-1">
              {subject.description && (
                <p className="text-xs text-muted-foreground italic pt-1">{subject.description}</p>
              )}
              <WatchTopicMeta
                key={`meta-${kind}-${subject.id}-${subject.topicId || ''}-${subject.focusArea || ''}`}
                subject={subject}
                allTopics={allTopics}
                onSaveTopic={(id, topicId) => updateWatchClassificationMutation.mutate({ id, topicId })}
                onSaveFocus={(id, focusArea) => updateWatchClassificationMutation.mutate({ id, focusArea })}
                saving={updateWatchClassificationMutation.isPending}
              />
              {split.recent.length === 0 && split.old.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2 text-center">No matching articles yet</p>
              ) : (
                <>
                  {split.recent.map((sub) => (
                    <a
                      key={sub.id}
                      href={sub.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block p-1.5 rounded hover-elevate"
                      data-testid={`${kind}-submission-${sub.id}`}
                    >
                      <div className="text-xs font-medium">{sub.headline}</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        {sub.sourceName || sub.sourceType} {sub.publishedAt ? `· ${format(new Date(sub.publishedAt), 'MMM d, h:mm a')}` : ''}
                      </div>
                    </a>
                  ))}
                  {split.old.length > 0 && (
                    <div className="mt-1">
                      <button
                        className="flex items-center gap-1 text-[10px] text-muted-foreground hover-elevate rounded px-1 py-0.5 w-full"
                        onClick={() => toggleOldSection(oldKey)}
                        data-testid={`button-${kind}-old-toggle-${subject.id}`}
                      >
                        {expandedOldSections.has(oldKey) ? <ChevronDown className="h-2.5 w-2.5 flex-shrink-0" /> : <ChevronRight className="h-2.5 w-2.5 flex-shrink-0" />}
                        <span>Old</span>
                        <Badge variant="secondary" className="text-[9px] ml-1">{split.old.length}</Badge>
                      </button>
                      {expandedOldSections.has(oldKey) && split.old.map((sub) => (
                        <a
                          key={sub.id}
                          href={sub.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block p-1.5 rounded hover-elevate opacity-70"
                          data-testid={`${kind}-old-submission-${sub.id}`}
                        >
                          <div className="text-xs font-medium">{sub.headline}</div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            {sub.sourceName || sub.sourceType} {sub.publishedAt ? `· ${format(new Date(sub.publishedAt), 'MMM d, h:mm a')}` : ''}
                          </div>
                        </a>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    );
  };

  return (
    <div className="flex-1 overflow-y-auto space-y-3 pr-1">
      {/* ── Influence panel ─────────────────────────────────────────────── */}
      <div className="rounded-md border border-purple-500/40 bg-purple-500/5 p-3 space-y-2" data-testid="section-watch-influence">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium flex items-center gap-2">
            <Radar className="w-4 h-4" /> Steering influence
            <Badge variant="secondary" data-testid="badge-watch-topic-counts">
              {priorityCount} Priority · {boloCount} BOLO
            </Badge>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5" title="Turn the live effect on/off. When on, Priority topics boost matching curated stories and BOLO topics keep matching stories from being filtered out as they come in.">
              <Switch
                checked={watchTopicSteeringEnabled}
                onCheckedChange={(checked) => toggleWatchTopicSteeringMutation.mutate(checked)}
                disabled={toggleWatchTopicSteeringMutation.isPending}
                data-testid="switch-watch-topic-steering"
              />
              <span className="text-xs text-muted-foreground">Live steering</span>
            </div>
            <div className="flex items-center gap-1.5" title="Auto-match new Team submissions to active priorities/BOLO topics (AI tagging on the Team page — a separate system from curated steering).">
              <Switch
                checked={joePriorityMatchingEnabled}
                onCheckedChange={(checked) => toggleJoePriorityMatchingMutation.mutate(checked)}
                disabled={toggleJoePriorityMatchingMutation.isPending}
                data-testid="switch-joe-priority-matching"
              />
              <span className="text-xs text-muted-foreground">Auto-match tagging</span>
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground" data-testid="text-steering-scope">
          Steering affects the <span className="font-medium text-foreground">Curated lane only</span> — main-feed steering is disabled by design.
          Watch topics also feed a separate AI-tagging matcher that labels Team-page submissions (the "Auto-match tagging" switch); that tagging never changes scores or feeds.
        </p>
        <button
          className="flex items-center gap-1 text-xs text-muted-foreground hover-elevate rounded px-1 py-0.5"
          onClick={() => setInfluenceOpen(v => !v)}
          data-testid="button-boost-mechanics-toggle"
        >
          {influenceOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          How the boost works
        </button>
        {influenceOpen && (
          <div className="text-xs text-muted-foreground space-y-1 pl-4" data-testid="text-boost-mechanics">
            <p>
              <span className="font-medium text-foreground">Priority boost:</span> when a curated item matches an active Priority topic, its score is nudged up by the topic's boost strength — Weak +8 (floor 60), Standard +15 (floor 66), Strong +22 (floor 72) — capped at 85. Boosts never demote: an item already above the floor keeps its higher score.
            </p>
            <p>
              <span className="font-medium text-foreground">BOLO rescue:</span> items the relevance filter would drop are rescued if they match a BOLO topic, within a bounded budget of 5 rescues per intake pass (max 2 per topic) so a broad topic can't flood the lane.
            </p>
            <p>
              Per-topic ~30-day telemetry (matches/day, average base score before boost, current boost strength) is shown in each topic's detail popup — click any topic below.
            </p>
            <p className="italic">
              The Scoring &amp; Relevance tab shows the base scoring ladder these boosts act on.
            </p>
          </div>
        )}
      </div>

      {/* ── Create box ──────────────────────────────────────────────────── */}
      <div className="rounded-md border p-3 space-y-3">
        <div className="text-xs text-muted-foreground">
          Add a topic to watch. <span className="font-medium text-purple-600 dark:text-purple-400">Priority</span> ranks matching stories higher; <span className="font-medium text-orange-500 dark:text-orange-400">BOLO</span> keeps them from being filtered out. Pick one or both.
        </div>
        <Textarea
          placeholder="Describe what to watch for... e.g., 'China military buildup near Taiwan'. You can list several topics at once."
          value={watchText}
          onChange={(e) => setWatchText(e.target.value)}
          className="text-sm min-h-[72px]"
          data-testid="input-watch-topic-text"
        />
        <div className="flex flex-col gap-2">
          <label htmlFor="watch-priority" className="flex items-start gap-2 cursor-pointer">
            <Checkbox
              id="watch-priority"
              checked={watchPriority}
              onCheckedChange={(v) => setWatchPriority(v === true)}
              className="mt-0.5"
              data-testid="checkbox-watch-priority"
            />
            <div className="leading-tight">
              <div className="text-xs font-medium text-purple-600 dark:text-purple-400">Priority — rank higher</div>
              <div className="text-[10px] text-muted-foreground">Gives matching stories a moderate ranking boost. Breaking news can still lead.</div>
            </div>
          </label>
          <label htmlFor="watch-bolo" className="flex items-start gap-2 cursor-pointer">
            <Checkbox
              id="watch-bolo"
              checked={watchBolo}
              onCheckedChange={(v) => setWatchBolo(v === true)}
              className="mt-0.5"
              data-testid="checkbox-watch-bolo"
            />
            <div className="leading-tight">
              <div className="text-xs font-medium text-orange-500 dark:text-orange-400">BOLO — never filter out</div>
              <div className="text-[10px] text-muted-foreground">Keeps matching stories even if they'd normally be filtered out as off-topic.</div>
            </div>
          </label>
        </div>
        <div className="text-[10px] text-muted-foreground">A focus area is suggested automatically — you can edit it on the topic after it's created.</div>
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">
            Have a specific article in mind? Paste its link to check for similar stories we already have (optional).
          </Label>
          <div className="flex items-center gap-2 flex-wrap">
            <Input
              type="url"
              placeholder="https://..."
              value={watchUrl}
              onChange={(e) => setWatchUrl(e.target.value)}
              className="text-sm flex-1 min-w-[200px]"
              data-testid="input-watch-url"
            />
            <Button
              variant="outline"
              onClick={checkSimilarArticles}
              disabled={similarLoading || !watchUrl.trim()}
              data-testid="button-check-similar"
            >
              {similarLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Search className="h-4 w-4 mr-1" />}
              Check
            </Button>
          </div>
          {similarResult && (
            <div className="text-xs" data-testid="watch-similar-results">
              {similarResult.matches.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-muted-foreground">
                    We already have {similarResult.matches.length} similar {similarResult.matches.length === 1 ? 'story' : 'stories'}:
                  </div>
                  {similarResult.matches.map((m) => (
                    <a
                      key={m.id}
                      href={m.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between gap-2 rounded-md border p-1.5 hover-elevate"
                      data-testid={`link-similar-${m.id}`}
                    >
                      <span className="truncate flex-1 min-w-0">{m.displayTitle || m.title}</span>
                      <span className="text-[10px] text-muted-foreground whitespace-nowrap">{m.source} · {Math.round(m.similarity * 100)}%</span>
                    </a>
                  ))}
                </div>
              ) : (
                <div className="text-muted-foreground">No similar stories found yet — this looks new.</div>
              )}
            </div>
          )}
        </div>
        <Button
          size="sm"
          className="w-full"
          onClick={handleWatchSubmit}
          disabled={watchSubmitting || !watchText.trim() || (!watchPriority && !watchBolo)}
          data-testid="button-watch-topic-submit"
        >
          {watchSubmitting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
          Add Watch Topic via AI
        </Button>
        {!watchPriority && !watchBolo && (
          <div className="text-[10px] text-muted-foreground text-center">Pick Priority, BOLO, or both to continue.</div>
        )}
      </div>

      {/* ── Sort control ────────────────────────────────────────────────── */}
      <div className="flex items-center justify-end gap-1.5">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Sort</span>
        <Select value={joePrioritySortMode} onValueChange={(v) => updateJoePrioritySortMode(v as JoeSortMode)}>
          <SelectTrigger className="h-8 w-[150px] text-xs" data-testid="select-joe-priority-sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent" className="text-xs">Recent activity</SelectItem>
            <SelectItem value="alpha" className="text-xs">A–Z</SelectItem>
            <SelectItem value="manual" className="text-xs">Manual order</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* ── Topic lists ─────────────────────────────────────────────────── */}
      {joePriorityLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : priorityCount === 0 && boloCount === 0 ? (
        <div className="py-6 text-center text-muted-foreground text-sm">
          <p>No priorities or BOLO items set</p>
          <p className="text-xs mt-1">Use the box above to add one</p>
        </div>
      ) : (
        <>
          {sortedJoePriorities.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-purple-500 dark:text-purple-400 uppercase tracking-wider mb-1 px-1 flex items-center gap-2">
                IE Priorities
                <Badge variant="secondary" className="text-[10px]">{sortedJoePriorities.length}</Badge>
              </div>
              {sortedJoePriorities.map((subject, index) => renderTopicCard(subject, 'jp', index, sortedJoePriorities))}
            </div>
          )}
          {sortedBoloItems.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-orange-500 dark:text-orange-400 uppercase tracking-wider mb-1 px-1 flex items-center gap-2">
                BOLO (Be On the Lookout)
                <Badge variant="secondary" className="text-[10px]">{sortedBoloItems.length}</Badge>
              </div>
              {sortedBoloItems.map((subject, index) => renderTopicCard(subject, 'bolo', index, sortedBoloItems))}
            </div>
          )}
        </>
      )}

      {/* ── Archived (Older Priorities) ─────────────────────────────────── */}
      {archivedCount > 0 && (
        <div className="border-t pt-2">
          <button
            className="flex items-center gap-2 w-full hover-elevate px-1 py-1"
            onClick={() => setOlderPrioritiesExpanded(!olderPrioritiesExpanded)}
            data-testid="button-older-priorities-toggle"
          >
            {olderPrioritiesExpanded ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            )}
            <span className="text-xs font-medium text-muted-foreground">Older Priorities</span>
            <Badge variant="secondary" className="text-[10px]">{archivedCount}</Badge>
          </button>
          {olderPrioritiesExpanded && (
            <div className="mt-1 space-y-1 opacity-70">
              {[
                ...(joePriorityData?.archivedJoePriorities || []).map(s => ({ subject: s, kind: 'jp' as const })),
                ...(joePriorityData?.archivedBoloItems || []).map(s => ({ subject: s, kind: 'bolo' as const })),
              ].map(({ subject, kind }) => (
                <div key={`archived-${kind}-${subject.id}`} className="flex items-center justify-between gap-2 p-2 rounded-md border border-dashed">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="text-xs text-muted-foreground truncate">{subject.name}</span>
                    {kind === 'bolo' && (
                      <Badge variant="outline" className="text-[10px] text-orange-400 flex-shrink-0">BOLO</Badge>
                    )}
                    {subject.totalCount > 0 && (
                      <Badge variant="outline" className="text-[10px] flex-shrink-0">{subject.totalCount}</Badge>
                    )}
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => restoreJoePriorityMutation.mutate(subject.id)}
                    title="Restore"
                    data-testid={`button-restore-${kind}-${subject.id}`}
                  >
                    <RotateCcw className="h-3 w-3 text-muted-foreground" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => deleteJoePriorityMutation.mutate(subject.id)}
                    title="Delete permanently"
                    data-testid={`button-delete-${kind}-${subject.id}`}
                  >
                    <Trash2 className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Detail dialog */}
      {detailSubject && (
        <WatchTopicDetailDialog
          subject={detailSubject}
          open={!!detailSubject}
          onOpenChange={(v) => { if (!v) setDetailSubject(null); }}
          allTopics={allTopics}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ['/api/team/joe-priorities-bolo'] })}
        />
      )}
    </div>
  );
}
