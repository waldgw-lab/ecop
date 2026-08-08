import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, Link, useLocation } from "wouter";
import {
  ArrowLeft, Save, Trash2, RefreshCw, Loader2, Shield, Plus, Lock,
  KeyRound, Image as ImageIcon, Upload, X, ExternalLink, EyeOff, Eye, Edit, ChevronDown, Newspaper, Clipboard, Sparkles, FileText, AtSign,
} from "lucide-react";
import { WarfighterGate } from "@/components/WarfighterGate";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import type { CustomMcop, CustomMcopArticle, CustomMcopScreenshot } from "@shared/schema";
import { INFLUENCER_X_ACCOUNTS } from "@shared/influencerXAccounts";

interface AuthStatus {
  hasPassword: boolean;
  unlocked: boolean;
  requiresSetup: boolean;
}

interface FeedArticle {
  id: string;
  title: string;
  url: string;
  source: string | null;
  scrapedAt: string;
  articlePublishedAt?: string | null;
  imageUrl: string | null;
  summaryBullets: string[];
  priorityScore: number;
  priorityOverride: number | null;
  basePriorityScore: number;
  type: 'scraped' | 'manual' | 'custom';
  isCustomArticle: boolean;
}

interface FeedResponse {
  topStories: FeedArticle[];
  screenshots: CustomMcopScreenshot[];
}

async function compressImage(file: File, maxSize = 1600, quality = 0.85): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxSize || height > maxSize) {
        const r = width / height;
        if (r > 1) { width = maxSize; height = Math.round(maxSize / r); }
        else { height = maxSize; width = Math.round(maxSize * r); }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Canvas error"));
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(b => b ? resolve(b) : reject(new Error("Compression failed")), "image/jpeg", quality);
    };
    img.onerror = () => reject(new Error("Image load failed"));
    img.src = URL.createObjectURL(file);
  });
}

async function uploadImage(file: File): Promise<string> {
  if (file.size > 10 * 1024 * 1024) throw new Error("File too large (max 10MB)");
  let blob: Blob = file;
  let name = file.name;
  if (file.size > 500 * 1024) {
    blob = await compressImage(file);
    name = file.name.replace(/\.[^.]+$/, ".jpg");
  }
  const fd = new FormData();
  fd.append("image", blob, name);
  const res = await fetch("/api/stream/upload-image", { method: "POST", body: fd, credentials: "include" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    let msg = `Upload failed (${res.status})`;
    try { const j = JSON.parse(t); if (j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  return data.url;
}

export default function CustomMcopAdmin() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  return (
    <WarfighterGate
      slug={slug}
      mode="admin"
      storageKey={`${slug ?? 'mcop'}-admin-unlocked`}
      title={`${slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : 'MCOP'} Admin`}
      subtitle="Enter the admin password to continue."
    >
      <CustomMcopAdminInner />
    </WarfighterGate>
  );
}

function CustomMcopAdminInner() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: authStatus, isLoading: authLoading } = useQuery<AuthStatus>({
    queryKey: ['/api/custom-mcops', slug, 'auth-status'],
    queryFn: async () => {
      const res = await fetch(`/api/custom-mcops/${slug}/auth-status`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
    enabled: !!slug,
  });

  if (authLoading || !authStatus) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (authStatus.requiresSetup) return <SetupPasswordGate slug={slug} />;
  if (!authStatus.unlocked) return <LoginGate slug={slug} />;
  return <AdminPanel slug={slug} navigate={navigate} toast={toast} />;
}

function SetupPasswordGate({ slug }: { slug: string }) {
  const { toast } = useToast();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const setMutation = useMutation({
    mutationFn: async (password: string) => apiRequest("POST", `/api/custom-mcops/${slug}/password`, { password }),
    onSuccess: () => {
      toast({ title: "Password set", description: "You're now signed in to this MCOP." });
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'auth-status'] });
    },
    onError: (e: any) => toast({ title: "Failed", description: e?.message || "", variant: "destructive" }),
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.length < 4) return toast({ title: "Password too short", description: "At least 4 characters.", variant: "destructive" });
    if (pw !== pw2) return toast({ title: "Passwords do not match", variant: "destructive" });
    setMutation.mutate(pw);
  };
  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <Card className="w-full max-w-sm bg-slate-800 border-slate-700">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-amber-500" />
            Set Admin Password
          </CardTitle>
          <p className="text-xs text-slate-400">This MCOP has no password yet. Set one to lock down its admin page.</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3">
            <div>
              <Label className="text-slate-300">New Password</Label>
              <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} className="bg-slate-700 border-slate-600 text-white" autoFocus data-testid="input-setup-password" />
            </div>
            <div>
              <Label className="text-slate-300">Confirm Password</Label>
              <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} className="bg-slate-700 border-slate-600 text-white" data-testid="input-setup-password-confirm" />
            </div>
            <Button type="submit" className="w-full" disabled={setMutation.isPending} data-testid="button-setup-password-submit">
              {setMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
              Set Password
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function LoginGate({ slug }: { slug: string }) {
  const { toast } = useToast();
  const [pw, setPw] = useState("");
  const loginMutation = useMutation({
    mutationFn: async (password: string) => apiRequest("POST", `/api/custom-mcops/${slug}/auth`, { password }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'auth-status'] }),
    onError: () => toast({ title: "Incorrect password", variant: "destructive" }),
  });
  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <Card className="w-full max-w-sm bg-slate-800 border-slate-700">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <Shield className="w-5 h-5 text-amber-500" />
            MCOP Admin
          </CardTitle>
          <p className="text-xs text-slate-400">Enter the password for this MCOP.</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => { e.preventDefault(); if (pw) loginMutation.mutate(pw); }} className="space-y-3">
            <div>
              <Label className="text-slate-300">Password</Label>
              <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} className="bg-slate-700 border-slate-600 text-white" autoFocus data-testid="input-mcop-login-password" />
            </div>
            <Button type="submit" className="w-full" disabled={loginMutation.isPending || !pw} data-testid="button-mcop-login-submit">
              {loginMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Lock className="w-4 h-4 mr-2" />}
              Unlock
            </Button>
            <Link href={`/mcop/${slug}`}>
              <Button type="button" variant="ghost" size="sm" className="w-full text-slate-400" data-testid="link-back-mcop-from-login">
                <ArrowLeft className="w-4 h-4 mr-1" /> Back to Dashboard
              </Button>
            </Link>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function AdminPanel({ slug, navigate, toast }: { slug: string; navigate: (p: string) => void; toast: ReturnType<typeof useToast>["toast"] }) {
  const { data: mcop, isLoading } = useQuery<CustomMcop>({
    queryKey: ['/api/custom-mcops', slug],
    queryFn: async () => {
      const res = await fetch(`/api/custom-mcops/${slug}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Not found');
      return res.json();
    },
    enabled: !!slug,
  });

  const [name, setName] = useState('');
  const [generalPrompt, setGeneralPrompt] = useState('');
  const [lookForNow, setLookForNow] = useState('');
  const [exclude, setExclude] = useState('');
  const [showChangePw, setShowChangePw] = useState(false);
  const [articleDialogOpen, setArticleDialogOpen] = useState(false);
  const [editingArticle, setEditingArticle] = useState<CustomMcopArticle | null>(null);
  const [editingFeedArticle, setEditingFeedArticle] = useState<FeedArticle | null>(null);
  const [outletsDialogOpen, setOutletsDialogOpen] = useState(false);
  const [xAccountsDialogOpen, setXAccountsDialogOpen] = useState(false);
  const [influencerAccountsDialogOpen, setInfluencerAccountsDialogOpen] = useState(false);
  const [screenshotDialogOpen, setScreenshotDialogOpen] = useState(false);

  useEffect(() => {
    if (mcop) {
      setName(mcop.name);
      setGeneralPrompt(mcop.generalPrompt);
      setLookForNow(mcop.lookForNow);
      setExclude(mcop.exclude);
    }
  }, [mcop]);

  const { data: feedData, isLoading: feedLoading } = useQuery<FeedResponse>({
    queryKey: ['/api/custom-mcops', slug, 'feed'],
    queryFn: async () => {
      const res = await fetch(`/api/custom-mcops/${slug}/feed`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
    enabled: !!slug,
    refetchInterval: editingArticle ? false : 30000,
  });

  const { data: articles = [] } = useQuery<CustomMcopArticle[]>({
    queryKey: ['/api/custom-mcops', slug, 'articles'],
    queryFn: async () => {
      const res = await fetch(`/api/custom-mcops/${slug}/articles`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
    enabled: !!slug,
  });

  const { data: screenshots = [] } = useQuery<CustomMcopScreenshot[]>({
    queryKey: ['/api/custom-mcops', slug, 'screenshots'],
    queryFn: async () => {
      const res = await fetch(`/api/custom-mcops/${slug}/screenshots`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
    enabled: !!slug,
  });

  const toggleFeedMutation = useMutation({
    mutationFn: async (feedFromMcop: boolean) => apiRequest('PATCH', `/api/custom-mcops/${slug}`, { feedFromMcop }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug] });
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'feed'] });
      toast({ title: 'Settings updated' });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => apiRequest('PATCH', `/api/custom-mcops/${slug}`, { name, generalPrompt, lookForNow, exclude }),
    onSuccess: () => {
      toast({ title: 'Saved', description: 'Priorities updated. Re-scoring stories now.' });
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug] });
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops'] });
    },
    onError: () => toast({ title: 'Save failed', variant: 'destructive' }),
  });

  const rescoreMutation = useMutation({
    mutationFn: async () => apiRequest('POST', `/api/custom-mcops/${slug}/rescore`, {}),
    onSuccess: () => toast({ title: 'Re-score started', description: 'Refresh in a minute to see updates.' }),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => apiRequest('DELETE', `/api/custom-mcops/${slug}`, {}),
    onSuccess: () => {
      toast({ title: 'Deleted' });
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops'] });
      navigate('/team');
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => apiRequest('POST', `/api/custom-mcops/${slug}/logout`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'auth-status'] }),
  });

  const deleteCustomArticleMutation = useMutation({
    mutationFn: async (id: string) => apiRequest('DELETE', `/api/custom-mcops/${slug}/articles/${id}`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'articles'] });
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'feed'] });
      toast({ title: 'Article removed' });
    },
  });

  const hideHeadlineMutation = useMutation({
    mutationFn: async ({ id, type }: { id: string; type: 'scraped' | 'manual' | 'custom' }) =>
      apiRequest('POST', `/api/custom-mcops/${slug}/hidden`, {
        sourceType: type === 'manual' ? 'manual' : 'headline',
        sourceId: id,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'feed'] });
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'hidden'] });
      toast({ title: 'Hidden from this MCOP' });
    },
  });

  const deleteScreenshotMutation = useMutation({
    mutationFn: async (id: string) => apiRequest('DELETE', `/api/custom-mcops/${slug}/screenshots/${id}`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'screenshots'] });
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'feed'] });
      toast({ title: 'Screenshot removed' });
    },
  });

  if (isLoading || !mcop) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  const displayedArticles = feedData?.topStories ?? [];

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="bg-slate-800 border-b border-slate-700 px-4 py-3 flex items-center justify-between gap-2 sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <Link href={`/mcop/${slug}`}>
            <Button size="icon" variant="ghost" className="text-slate-300" data-testid="button-mcop-admin-back">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          </Link>
          <Shield className="w-5 h-5 text-amber-500" />
          <h1 className="text-lg font-bold">{mcop.name} — Admin</h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => setShowChangePw(true)} data-testid="button-change-mcop-password">
            <KeyRound className="w-4 h-4 mr-1" /> Change Password
          </Button>
          <Button variant="ghost" size="sm" className="text-slate-300" onClick={() => logoutMutation.mutate()} data-testid="button-mcop-logout">
            Lock
          </Button>
          <Button onClick={() => { setEditingArticle(null); setArticleDialogOpen(true); }} data-testid="button-mcop-admin-add-article">
            <Plus className="w-4 h-4 mr-2" /> Submit Article
          </Button>
        </div>
      </header>

      <div className="max-w-7xl mx-auto p-4 space-y-6">
        {/* Editable Name */}
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white text-sm">MCOP Name</CardTitle>
          </CardHeader>
          <CardContent>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="bg-slate-700 border-slate-600 text-white" data-testid="input-mcop-name" />
          </CardContent>
        </Card>

        {/* Feed Settings */}
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white text-sm">Feed Settings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-slate-200 text-sm font-medium">Feed from MCOP</Label>
                <p className="text-xs text-slate-400 mt-0.5">
                  When enabled, mirrors stories from the MCOP Stream into this dashboard's Top Stories alongside any manually submitted articles.
                </p>
              </div>
              <Switch
                checked={mcop.feedFromMcop ?? true}
                onCheckedChange={(checked) => toggleFeedMutation.mutate(checked)}
                data-testid="switch-mcop-admin-feed-mcop"
              />
            </div>
          </CardContent>
        </Card>

        {/* Three Priority Boxes — collapsed by default */}
        <Collapsible defaultOpen={false}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="w-full flex items-center justify-between gap-2 rounded-md bg-slate-800 border border-slate-700 px-4 py-3 text-left hover-elevate active-elevate-2"
              data-testid="button-toggle-priority-scoring"
            >
              <div>
                <div className="text-white text-sm font-semibold">Modify Priority Scoring</div>
                <div className="text-xs text-slate-400 mt-0.5">Plain-English instructions that drive how stories are scored for this MCOP.</div>
              </div>
              <ChevronDown className="w-4 h-4 text-slate-400 transition-transform data-[state=open]:rotate-180" />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-6 mt-6">
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white text-sm">What this MCOP is about</CardTitle>
            <p className="text-xs text-slate-400">Describe in plain English who this dashboard serves and what kinds of stories matter most. Write it like you'd brief a new analyst.</p>
          </CardHeader>
          <CardContent>
            <Textarea
              value={generalPrompt}
              onChange={(e) => setGeneralPrompt(e.target.value)}
              rows={8}
              className="bg-slate-700 border-slate-600 text-white text-sm leading-relaxed resize-none"
              placeholder="Example: This MCOP is for our Indo-Pacific desk. Prioritize anything about the South China Sea, Taiwan, US-China military posture, semiconductor supply chains, and senior PRC leadership statements."
              data-testid="input-general-prompt"
            />
          </CardContent>
        </Card>

        <Card className="bg-slate-800 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white text-sm">What we're watching for right now</CardTitle>
            <p className="text-xs text-slate-400">Active topics, briefings, or events to boost. Update this whenever priorities shift.</p>
          </CardHeader>
          <CardContent>
            <Textarea
              value={lookForNow}
              onChange={(e) => setLookForNow(e.target.value)}
              rows={5}
              className="bg-slate-700 border-slate-600 text-white text-sm leading-relaxed resize-none"
              placeholder="Example: Upcoming UN summit; arms shipments to Taiwan; any statements from SecDef on Pacific deployments."
              data-testid="input-look-for-now"
            />
          </CardContent>
        </Card>

        <Card className="bg-slate-800 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white text-sm">What to push down or hide</CardTitle>
            <p className="text-xs text-slate-400">Topics or sources to deprioritize so they don't crowd out what matters.</p>
          </CardHeader>
          <CardContent>
            <Textarea
              value={exclude}
              onChange={(e) => setExclude(e.target.value)}
              rows={5}
              className="bg-slate-700 border-slate-600 text-white text-sm leading-relaxed resize-none"
              placeholder="Example: Domestic celebrity scandals; routine sports news; weather unless it's a federal disaster."
              data-testid="input-exclude"
            />
          </CardContent>
        </Card>
          </CollapsibleContent>
        </Collapsible>

        <div className="flex items-center justify-end gap-2 flex-wrap">
          <Button variant="outline" onClick={() => rescoreMutation.mutate()} disabled={rescoreMutation.isPending} data-testid="button-rescore-mcop">
            <RefreshCw className={`w-4 h-4 mr-1 ${rescoreMutation.isPending ? 'animate-spin' : ''}`} /> Re-score Now
          </Button>
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} data-testid="button-save-mcop">
            <Save className="w-4 h-4 mr-1" /> {saveMutation.isPending ? 'Saving...' : 'Save Priorities'}
          </Button>
        </div>

        {/* Two-column: Displayed Articles + Screenshots */}
        <div className="flex gap-6 flex-wrap lg:flex-nowrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
              <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider">
                Displayed Articles ({displayedArticles.length})
              </h2>
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setXAccountsDialogOpen(true)}
                  data-testid="button-mcop-admin-x-accounts"
                >
                  <AtSign className="w-3.5 h-3.5 mr-1" /> X Accounts
                </Button>
                {slug !== 'cyber' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setInfluencerAccountsDialogOpen(true)}
                    data-testid="button-mcop-admin-influencer-accounts"
                  >
                    <AtSign className="w-3.5 h-3.5 mr-1" /> Influencer Accounts
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setOutletsDialogOpen(true)}
                  data-testid="button-mcop-admin-outlets"
                >
                  <Newspaper className="w-3.5 h-3.5 mr-1" /> Outlets
                </Button>
              </div>
            </div>
            <p className="text-xs text-slate-500 mb-4">
              Live Top Stories for this MCOP. Click a manual article to edit it; use the hide button to remove a scraped headline from this MCOP only.
            </p>

            {feedLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
              </div>
            ) : displayedArticles.length > 0 ? (
              <div className="space-y-2">
                {displayedArticles.slice(0, 12).length > 0 && (
                  <div className="rounded-md border-2 border-blue-500/60 p-2 space-y-2">
                    <div className="flex items-center gap-2 px-1 pb-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-blue-400">In Carousel Rotation</span>
                      <span className="text-[10px] text-slate-500">(top {Math.min(12, displayedArticles.length)})</span>
                    </div>
                    {displayedArticles.slice(0, 12).map((article, index) => (
                      <ArticleRow
                        key={article.id}
                        article={article}
                        rank={index + 1}
                        onEditCustom={() => {
                          const realId = article.id.startsWith('custom-') ? article.id.slice(7) : article.id;
                          const found = articles.find(a => a.id === realId);
                          if (found) { setEditingArticle(found); setArticleDialogOpen(true); }
                        }}
                        onDeleteCustom={() => {
                          const realId = article.id.startsWith('custom-') ? article.id.slice(7) : article.id;
                          if (confirm('Delete this article?')) deleteCustomArticleMutation.mutate(realId);
                        }}
                        onHideScraped={() => hideHeadlineMutation.mutate({ id: article.id, type: article.type })}
                        onEditScraped={() => setEditingFeedArticle(article)}
                      />
                    ))}
                  </div>
                )}
                {displayedArticles.length > 12 && (
                  <div className="space-y-2 pt-1">
                    <div className="flex items-center gap-2 px-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Bench (not in rotation)</span>
                    </div>
                    {displayedArticles.slice(12).map((article, index) => (
                      <ArticleRow
                        key={article.id}
                        article={article}
                        rank={index + 13}
                        onEditCustom={() => {
                          const realId = article.id.startsWith('custom-') ? article.id.slice(7) : article.id;
                          const found = articles.find(a => a.id === realId);
                          if (found) { setEditingArticle(found); setArticleDialogOpen(true); }
                        }}
                        onDeleteCustom={() => {
                          const realId = article.id.startsWith('custom-') ? article.id.slice(7) : article.id;
                          if (confirm('Delete this article?')) deleteCustomArticleMutation.mutate(realId);
                        }}
                        onHideScraped={() => hideHeadlineMutation.mutate({ id: article.id, type: article.type })}
                        onEditScraped={() => setEditingFeedArticle(article)}
                      />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <Card className="bg-slate-800/50 border-slate-700">
                <CardContent className="py-8 text-center text-slate-500 text-sm">
                  No articles in this MCOP's feed yet. Submit an article manually or wait for scraped stories to be scored.
                </CardContent>
              </Card>
            )}
          </div>

          <div className="w-full lg:w-80 lg:flex-shrink-0">
            <div className="lg:sticky lg:top-20">
              <div className="flex items-center justify-between mb-3 gap-2">
                <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider">
                  Screenshots ({screenshots.length})
                </h2>
                <Button size="sm" onClick={() => setScreenshotDialogOpen(true)} data-testid="button-mcop-admin-add-screenshot">
                  <Upload className="w-3 h-3 mr-1" /> Upload
                </Button>
              </div>
              <p className="text-xs text-slate-500 mb-4">
                Appear in this MCOP's X column.
              </p>

              {screenshots.length > 0 ? (
                <div className="space-y-2">
                  {screenshots.map(ss => (
                    <Card key={ss.id} className="bg-slate-800/50 border-slate-700" data-testid={`card-mcop-screenshot-${ss.id}`}>
                      <CardContent className="py-3 px-4">
                        <div className="flex items-start gap-3">
                          <img
                            src={ss.imageUrl}
                            alt={ss.caption}
                            className="w-16 h-12 object-cover rounded flex-shrink-0"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-white line-clamp-2" data-testid={`text-mcop-screenshot-caption-${ss.id}`}>{ss.caption}</p>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              {ss.sourceLabel && (
                                <Badge variant="outline" className="text-cyan-400 border-cyan-600 text-[10px]">{ss.sourceLabel}</Badge>
                              )}
                              <span className="text-[10px] text-slate-500">
                                {new Date(ss.createdAt).toLocaleString()}
                              </span>
                            </div>
                          </div>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="text-red-400 flex-shrink-0"
                            onClick={() => { if (confirm('Delete this screenshot?')) deleteScreenshotMutation.mutate(ss.id); }}
                            data-testid={`button-delete-mcop-screenshot-${ss.id}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <Card className="bg-slate-800/50 border-slate-700">
                  <CardContent className="py-6 text-center text-slate-500 text-sm">
                    No screenshots uploaded yet.
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </div>

        <HiddenItemsCard slug={slug} />
      </div>

      <Dialog open={articleDialogOpen} onOpenChange={setArticleDialogOpen}>
        <DialogContent className="sm:max-w-lg bg-slate-800 border-slate-700 text-white max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingArticle ? 'Edit Article' : 'Submit Article'}</DialogTitle>
          </DialogHeader>
          <ArticleForm
            slug={slug}
            article={editingArticle}
            onDone={() => { setArticleDialogOpen(false); setEditingArticle(null); }}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingFeedArticle} onOpenChange={(open) => { if (!open) setEditingFeedArticle(null); }}>
        <DialogContent className="sm:max-w-lg bg-slate-800 border-slate-700 text-white max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Story</DialogTitle>
          </DialogHeader>
          {editingFeedArticle && (
            <EditFeedArticleForm
              slug={slug}
              article={editingFeedArticle}
              onDone={() => setEditingFeedArticle(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={xAccountsDialogOpen} onOpenChange={setXAccountsDialogOpen}>
        <DialogContent className="sm:max-w-md bg-slate-800 border-slate-700 text-white max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>X Accounts</DialogTitle>
            <p className="text-xs text-slate-400">
              Choose which X accounts users can pick from in the X Feeds column on the Warfighter dashboard. Unchecked accounts are hidden from the filter dropdown and their posts don't appear.
            </p>
          </DialogHeader>
          <XAccountsList slug={slug} />
        </DialogContent>
      </Dialog>

      <Dialog open={influencerAccountsDialogOpen} onOpenChange={setInfluencerAccountsDialogOpen}>
        <DialogContent className="sm:max-w-md bg-slate-800 border-slate-700 text-white max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Influencer Accounts</DialogTitle>
            <p className="text-xs text-slate-400">
              Choose which influencer accounts users can pick from in the Influencer X Posts column on the Warfighter dashboard. Unchecked accounts are hidden from the filter dropdown and their posts don't appear.
            </p>
          </DialogHeader>
          <InfluencerXAccountsList slug={slug} />
        </DialogContent>
      </Dialog>

      <Dialog open={outletsDialogOpen} onOpenChange={setOutletsDialogOpen}>
        <DialogContent className="sm:max-w-md bg-slate-800 border-slate-700 text-white max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Outlets</DialogTitle>
            <p className="text-xs text-slate-400">
              All media outlets feeding stories to this MCOP. Uncheck an outlet to hide every story from it on the Warfighter dashboard.
            </p>
          </DialogHeader>
          <OutletsList slug={slug} />
        </DialogContent>
      </Dialog>

      <Dialog open={screenshotDialogOpen} onOpenChange={setScreenshotDialogOpen}>
        <DialogContent className="sm:max-w-lg bg-slate-800 border-slate-700 text-white">
          <DialogHeader>
            <DialogTitle>Upload Screenshot</DialogTitle>
          </DialogHeader>
          <ScreenshotForm slug={slug} onDone={() => setScreenshotDialogOpen(false)} />
        </DialogContent>
      </Dialog>

      <Dialog open={showChangePw} onOpenChange={setShowChangePw}>
        <DialogContent className="sm:max-w-sm bg-slate-800 border-slate-700 text-white">
          <DialogHeader><DialogTitle>Change MCOP Password</DialogTitle></DialogHeader>
          <ChangePasswordForm slug={slug} onDone={() => setShowChangePw(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ArticleRow({
  article,
  rank,
  onEditCustom,
  onDeleteCustom,
  onHideScraped,
  onEditScraped,
}: {
  article: FeedArticle;
  rank: number;
  onEditCustom: () => void;
  onDeleteCustom: () => void;
  onHideScraped: () => void;
  onEditScraped: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const imageToShow = article.imageUrl?.startsWith('VIDEO:') ? null : article.imageUrl;
  const isCustom = article.isCustomArticle;

  return (
    <Card
      className={`bg-slate-800/50 border-slate-700 ${isCustom ? 'cursor-pointer transition-colors hover:bg-slate-700/60 hover:border-slate-600' : ''}`}
      onClick={isCustom ? onEditCustom : undefined}
      data-testid={`card-mcop-article-${article.id}`}
    >
      <CardContent className="py-3 px-4">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-6 text-center">
            <span className="text-xs font-mono text-slate-500">#{rank}</span>
          </div>
          {imageToShow && (
            <img
              src={imageToShow}
              alt=""
              className="w-16 h-12 object-cover rounded flex-shrink-0"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-medium text-white line-clamp-1" data-testid={`text-mcop-article-title-${article.id}`}>{article.title}</h3>
              <a
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="w-3 h-3 text-slate-500" />
              </a>
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {isCustom ? (
                <Badge variant="outline" className="text-emerald-400 border-emerald-600 text-[10px]">MANUAL</Badge>
              ) : (
                <Badge variant="outline" className="text-blue-400 border-blue-600 text-[10px]">MCOP</Badge>
              )}
              {article.source && <span className="text-xs text-slate-400">{article.source}</span>}
              <span className="text-xs text-slate-500 font-mono">P:{article.priorityScore}</span>
              {article.summaryBullets && article.summaryBullets.length > 0 && (
                <span className="text-xs text-slate-500">{article.summaryBullets.length} bullets</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            {isCustom ? (
              <>
                <Button size="icon" variant="ghost" className="text-slate-400" onClick={onEditCustom} data-testid={`button-mcop-article-edit-${article.id}`}>
                  <Edit className="w-3.5 h-3.5" />
                </Button>
                {confirmDelete ? (
                  <div className="flex items-center gap-1">
                    <Button size="icon" variant="ghost" className="text-red-400" onClick={() => { onDeleteCustom(); setConfirmDelete(false); }} data-testid={`button-mcop-article-confirm-delete-${article.id}`}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => setConfirmDelete(false)} data-testid={`button-mcop-article-cancel-delete-${article.id}`}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ) : (
                  <Button size="icon" variant="ghost" onClick={() => setConfirmDelete(true)} data-testid={`button-mcop-article-delete-${article.id}`}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button size="icon" variant="ghost" className="text-slate-400" onClick={onEditScraped} title="Edit photo, title, bullets, priority" data-testid={`button-mcop-article-edit-${article.id}`}>
                  <Edit className="w-3.5 h-3.5" />
                </Button>
                <Button size="icon" variant="ghost" className="text-slate-400" onClick={onHideScraped} title="Hide from this MCOP" data-testid={`button-mcop-article-hide-${article.id}`}>
                  <EyeOff className="w-3.5 h-3.5" />
                </Button>
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface HiddenItem {
  id: string;
  mcopId: string;
  sourceType: string;
  sourceId: string;
  hiddenAt: string;
}

const SOURCE_LABELS: Record<string, string> = {
  headline: 'Headline',
  truth_social: 'Truth Social post',
  x_post: 'X post (SecWar)',
  rapidresponse_post: 'X post (RapidResponse)',
  dow_response_post: 'X post (DOWResponse)',
  sentdefender_post: 'X post (sentdefender)',
  first_alert: 'Dataminr alert',
  xAccount: 'X account (disabled)',
};

const X_ACCOUNTS_ALL = [
  { id: 'SecWar', label: '@SecWar' },
  { id: 'PeteHegseth', label: '@PeteHegseth' },
  { id: 'SeanParnellASW', label: '@SeanParnellASW' },
  { id: 'DOWResponse', label: '@DOWResponse' },
  { id: 'TheJointStaff', label: '@TheJointStaff' },
  { id: 'SecArmy', label: '@SecArmy' },
  { id: 'SecAFOfficial', label: '@SecAFOfficial' },
  { id: 'SecRubio', label: '@SecRubio' },
  { id: 'SenMarcoRubio', label: '@SenMarcoRubio' },
  { id: 'PressSec', label: '@PressSec' },
  { id: 'Rapidresponse47', label: '@Rapidresponse47' },
  { id: 'sentdefender', label: '@sentdefender' },
];

function XAccountsList({ slug }: { slug: string }) {
  const { toast } = useToast();
  const { data: items = [], isLoading } = useQuery<HiddenItem[]>({
    queryKey: ['/api/custom-mcops', slug, 'hidden'],
    queryFn: async () => {
      const res = await fetch(`/api/custom-mcops/${slug}/hidden`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
    enabled: !!slug,
  });

  const hiddenIds = new Set(items.filter(i => i.sourceType === 'xAccount').map(i => i.sourceId));

  const toggle = useMutation({
    mutationFn: async ({ id, enable }: { id: string; enable: boolean }) => {
      if (enable) {
        return apiRequest('DELETE', `/api/custom-mcops/${slug}/hidden`, { sourceType: 'xAccount', sourceId: id });
      }
      return apiRequest('POST', `/api/custom-mcops/${slug}/hidden`, { sourceType: 'xAccount', sourceId: id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'hidden'] });
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'feed'] });
    },
    onError: () => toast({ title: 'Failed to update', variant: 'destructive' }),
  });

  if (isLoading) {
    return <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>;
  }

  return (
    <div className="space-y-1 overflow-y-auto">
      {X_ACCOUNTS_ALL.map(acct => {
        const enabled = !hiddenIds.has(acct.id);
        return (
          <label
            key={acct.id}
            className="flex items-center gap-3 px-3 py-2 rounded-md border border-slate-700 bg-slate-800/40 cursor-pointer"
            data-testid={`row-x-account-${acct.id}`}
          >
            <input
              type="checkbox"
              checked={enabled}
              disabled={toggle.isPending}
              onChange={(e) => toggle.mutate({ id: acct.id, enable: e.target.checked })}
              className="w-4 h-4 accent-blue-500"
              data-testid={`toggle-x-account-${acct.id}`}
            />
            <span className="text-sm text-slate-200 flex-1">{acct.label}</span>
            <span className={`text-[10px] uppercase tracking-wider ${enabled ? 'text-emerald-400' : 'text-slate-500'}`}>
              {enabled ? 'Enabled' : 'Disabled'}
            </span>
          </label>
        );
      })}
      <p className="text-[11px] text-slate-500 pt-2">
        Disabling an account removes it from the X Feeds filter dropdown on the Warfighter dashboard and stops its posts from being shown to users.
      </p>
    </div>
  );
}

function InfluencerXAccountsList({ slug }: { slug: string }) {
  const { toast } = useToast();
  const { data: items = [], isLoading } = useQuery<HiddenItem[]>({
    queryKey: ['/api/custom-mcops', slug, 'hidden'],
    queryFn: async () => {
      const res = await fetch(`/api/custom-mcops/${slug}/hidden`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
    enabled: !!slug,
  });

  const hiddenIds = new Set(items.filter(i => i.sourceType === 'influencerXAccount').map(i => i.sourceId));

  const toggle = useMutation({
    mutationFn: async ({ id, enable }: { id: string; enable: boolean }) => {
      if (enable) {
        return apiRequest('DELETE', `/api/custom-mcops/${slug}/hidden`, { sourceType: 'influencerXAccount', sourceId: id });
      }
      return apiRequest('POST', `/api/custom-mcops/${slug}/hidden`, { sourceType: 'influencerXAccount', sourceId: id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'hidden'] });
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'feed'] });
    },
    onError: () => toast({ title: 'Failed to update', variant: 'destructive' }),
  });

  if (isLoading) {
    return <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>;
  }

  return (
    <div className="space-y-1 overflow-y-auto">
      {INFLUENCER_X_ACCOUNTS.map(acct => {
        const enabled = !hiddenIds.has(acct.id);
        return (
          <label
            key={acct.id}
            className="flex items-center gap-3 px-3 py-2 rounded-md border border-slate-700 bg-slate-800/40 cursor-pointer"
            data-testid={`row-influencer-x-account-${acct.id}`}
          >
            <input
              type="checkbox"
              checked={enabled}
              disabled={toggle.isPending}
              onChange={(e) => toggle.mutate({ id: acct.id, enable: e.target.checked })}
              className="w-4 h-4 accent-blue-500"
              data-testid={`toggle-influencer-x-account-${acct.id}`}
            />
            <span className="text-sm text-slate-200 flex-1">{acct.label}</span>
            <span className={`text-[10px] uppercase tracking-wider ${enabled ? 'text-emerald-400' : 'text-slate-500'}`}>
              {enabled ? 'Enabled' : 'Disabled'}
            </span>
          </label>
        );
      })}
      <p className="text-[11px] text-slate-500 pt-2">
        Disabling an account removes it from the Influencer X Posts filter dropdown on the Warfighter dashboard and stops its posts from being shown to users.
      </p>
    </div>
  );
}

function HiddenItemsCard({ slug }: { slug: string }) {
  const { toast } = useToast();
  const { data: items = [], isLoading } = useQuery<HiddenItem[]>({
    queryKey: ['/api/custom-mcops', slug, 'hidden'],
    queryFn: async () => {
      const res = await fetch(`/api/custom-mcops/${slug}/hidden`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
    enabled: !!slug,
  });

  const unhide = useMutation({
    mutationFn: async (item: HiddenItem) =>
      apiRequest('DELETE', `/api/custom-mcops/${slug}/hidden`, { sourceType: item.sourceType, sourceId: item.sourceId }),
    onSuccess: () => {
      toast({ title: 'Restored', description: 'Item is visible again.' });
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'hidden'] });
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'feed'] });
    },
    onError: () => toast({ title: 'Failed', variant: 'destructive' }),
  });

  return (
    <Card className="bg-slate-800 border-slate-700">
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <EyeOff className="w-4 h-4 text-slate-400" />
            <CardTitle className="text-white text-sm">Hidden from this MCOP</CardTitle>
          </div>
          <span className="text-xs text-slate-400">{items.length} item{items.length === 1 ? '' : 's'}</span>
        </div>
        <p className="text-xs text-slate-400">Items you've hidden from this MCOP's feed. They still show up everywhere else.</p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-4"><Loader2 className="w-4 h-4 animate-spin text-slate-400" /></div>
        ) : items.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-4">Nothing hidden yet. Use the hide button on any item in your dashboard or in the Displayed Articles list above.</p>
        ) : (
          <div className="space-y-2">
            {items.map(item => (
              <div key={item.id} className="flex items-center justify-between gap-3 border border-slate-700 rounded-md p-2 bg-slate-800/50" data-testid={`item-hidden-${item.id}`}>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-slate-200">{SOURCE_LABELS[item.sourceType] || item.sourceType}</div>
                  <div className="text-[10px] text-slate-500 truncate">{item.sourceId}</div>
                  <div className="text-[10px] text-slate-500">Hidden {new Date(item.hiddenAt).toLocaleString()}</div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => unhide.mutate(item)}
                  disabled={unhide.isPending}
                  data-testid={`button-unhide-${item.id}`}
                >
                  <Eye className="w-3.5 h-3.5 mr-1" /> Restore
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ArticleForm({ slug, article, onDone }: { slug: string; article: CustomMcopArticle | null; onDone: () => void }) {
  const { toast } = useToast();
  const [title, setTitle] = useState(article?.title ?? "");
  const [url, setUrl] = useState(article?.url ?? "");
  const [imageUrl, setImageUrl] = useState(article?.imageUrl ?? "");
  const [source, setSource] = useState(article?.source ?? "");
  const [priorityScore, setPriorityScore] = useState(String(article?.priorityScore ?? 75));
  const [bulletsText, setBulletsText] = useState(article?.summaryBullets?.join("\n") ?? "");
  const [uploading, setUploading] = useState(false);
  const [autoFilling, setAutoFilling] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAutoFill = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      toast({ title: "Paste a URL first", variant: "destructive" });
      return;
    }
    try { new URL(trimmed); } catch {
      toast({ title: "Invalid URL", variant: "destructive" });
      return;
    }
    setAutoFilling(true);
    try {
      const res = await apiRequest("POST", `/api/custom-mcops/${slug}/scrape-url-preview`, { url: trimmed });
      const data: { title: string | null; source: string | null; ogImageUrl: string | null; summaryBullets: string[] } = await res.json();
      // Only fill empty fields so we don't clobber the admin's edits
      if (data.title && !title.trim()) setTitle(data.title);
      if (data.source && !source.trim()) setSource(data.source);
      if (data.ogImageUrl && !imageUrl.trim()) setImageUrl(data.ogImageUrl);
      if (data.summaryBullets?.length && !bulletsText.trim()) setBulletsText(data.summaryBullets.join("\n"));
      const filled = [
        data.title && "headline",
        data.source && "source",
        data.ogImageUrl && "image",
        data.summaryBullets?.length && "bullets",
      ].filter(Boolean);
      if (filled.length === 0) {
        toast({ title: "Nothing to auto-fill", description: "The page didn't expose usable metadata. Fill in manually.", variant: "destructive" });
      } else {
        toast({ title: "Auto-filled", description: `Pulled: ${filled.join(", ")}. Edit anything before saving.` });
      }
    } catch (e: any) {
      toast({ title: "Auto-fill failed", description: e?.message || "Could not scrape the page", variant: "destructive" });
    } finally {
      setAutoFilling(false);
    }
  };

  const handleUpload = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const u = await uploadImage(file);
      setImageUrl(u);
      toast({ title: "Image uploaded" });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }, [toast]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        e.preventDefault();
        const f = items[i].getAsFile();
        if (f) handleUpload(f);
        return;
      }
    }
  }, [handleUpload]);

  const mutation = useMutation({
    mutationFn: async (data: any) => {
      if (article) return apiRequest("PATCH", `/api/custom-mcops/${slug}/articles/${article.id}`, data);
      return apiRequest("POST", `/api/custom-mcops/${slug}/articles`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'articles'] });
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'feed'] });
      toast({ title: article ? "Updated" : "Added" });
      onDone();
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !url.trim()) return;
    const bullets = bulletsText.trim() ? bulletsText.split("\n").map(b => b.trim()).filter(b => b) : null;
    mutation.mutate({
      title: title.trim(),
      url: url.trim(),
      imageUrl: imageUrl.trim() || null,
      source: source.trim() || null,
      priorityScore: parseInt(priorityScore) || 50,
      summaryBullets: bullets,
    });
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <Label className="text-slate-300 text-xs">Link *</Label>
        <div className="flex gap-2">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste URL, then click Auto-fill" className="bg-slate-700 border-slate-600 text-white flex-1" required data-testid="input-article-url" />
          <Button
            type="button"
            variant="outline"
            onClick={handleAutoFill}
            disabled={autoFilling || !url.trim()}
            data-testid="button-article-autofill"
          >
            {autoFilling ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Sparkles className="w-4 h-4 mr-2" />}
            {autoFilling ? "Scraping..." : "Auto-fill"}
          </Button>
        </div>
        <p className="text-[10px] text-slate-500 mt-1">Paste a URL and click Auto-fill — the scraper will fill in the headline, source, image, and summary bullets. Edit anything before saving.</p>
      </div>
      <div>
        <Label className="text-slate-300 text-xs">Headline *</Label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} className="bg-slate-700 border-slate-600 text-white" required data-testid="input-article-title" />
      </div>
      <div onPaste={handlePaste}>
        <Label className="text-slate-300 text-xs">Photo</Label>
        <Input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="Paste image URL or upload below" className="bg-slate-700 border-slate-600 text-white" data-testid="input-article-image" />
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); if (fileInputRef.current) fileInputRef.current.value = ""; }} />
        <div className="flex items-center gap-2 mt-2">
          <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading} data-testid="button-article-upload-image">
            {uploading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Upload className="w-4 h-4 mr-2" />}
            {uploading ? "Uploading..." : "Upload Photo"}
          </Button>
          <span className="text-[10px] text-slate-500">or paste an image from clipboard</span>
        </div>
        {imageUrl && (
          <img src={imageUrl} alt="" className="mt-2 w-32 h-20 object-cover rounded" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-slate-300 text-xs">Source</Label>
          <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. CNN" className="bg-slate-700 border-slate-600 text-white" data-testid="input-article-source" />
        </div>
        <div>
          <Label className="text-slate-300 text-xs">Priority (1-100)</Label>
          <Input type="number" value={priorityScore} onChange={(e) => setPriorityScore(e.target.value)} min="1" max="100" className="bg-slate-700 border-slate-600 text-white" data-testid="input-article-priority" />
        </div>
      </div>
      <div>
        <Label className="text-slate-300 text-xs">Summary Bullets (one per line)</Label>
        <Textarea value={bulletsText} onChange={(e) => setBulletsText(e.target.value)} rows={3} className="bg-slate-700 border-slate-600 text-white resize-none" data-testid="input-article-bullets" />
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" className="text-slate-300" onClick={onDone} data-testid="button-article-cancel">Cancel</Button>
        <Button type="submit" disabled={mutation.isPending || !title.trim() || !url.trim()} data-testid="button-article-submit">
          {mutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
          {article ? "Update" : "Add"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ScreenshotForm({ slug, onDone }: { slug: string; onDone: () => void }) {
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [priorityScore, setPriorityScore] = useState("50");
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const select = (f: File) => {
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        e.preventDefault();
        const f = items[i].getAsFile();
        if (f) select(f);
        return;
      }
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return toast({ title: "Pick an image first", variant: "destructive" });
    setSubmitting(true);
    try {
      const url = await uploadImage(file);
      await apiRequest("POST", `/api/custom-mcops/${slug}/screenshots`, {
        caption: sourceLabel.trim() || "Screenshot",
        imageUrl: url,
        sourceLabel: sourceLabel.trim() || null,
        linkUrl: linkUrl.trim() || null,
        priorityScore: parseInt(priorityScore) || 50,
      });
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'screenshots'] });
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'feed'] });
      toast({ title: "Screenshot added" });
      onDone();
    } catch (err: any) {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3" onPaste={handlePaste}>
      <div>
        <Label className="text-slate-300 text-xs">Screenshot Image *</Label>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) select(f); }}
          data-testid="input-screenshot-file"
        />
        {previewUrl ? (
          <div className="relative mt-1">
            <img src={previewUrl} alt="Preview" className="w-full max-h-48 object-contain rounded bg-slate-700" />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute top-1 right-1 bg-black/50 text-white"
              onClick={() => { setFile(null); setPreviewUrl(null); }}
              data-testid="button-screenshot-clear"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        ) : (
          <div
            className="border-2 border-dashed border-slate-600 rounded-lg p-6 text-center cursor-pointer hover:border-slate-500 transition-colors mt-1"
            onClick={() => fileInputRef.current?.click()}
            data-testid="button-screenshot-select"
          >
            <ImageIcon className="w-8 h-8 mx-auto mb-2 text-slate-500" />
            <p className="text-sm text-slate-400">Click to select or paste a screenshot</p>
          </div>
        )}
      </div>
      <div>
        <Label className="text-slate-300 text-xs">Source Label (optional)</Label>
        <Input value={sourceLabel} onChange={(e) => setSourceLabel(e.target.value)} placeholder="e.g. @elonmusk on X" className="bg-slate-700 border-slate-600 text-white" data-testid="input-screenshot-source" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-slate-300 text-xs">Link URL (optional)</Label>
          <Input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://x.com/..." className="bg-slate-700 border-slate-600 text-white" data-testid="input-screenshot-link" />
        </div>
        <div>
          <Label className="text-slate-300 text-xs">Priority (1-100)</Label>
          <Input type="number" value={priorityScore} onChange={(e) => setPriorityScore(e.target.value)} min="1" max="100" className="bg-slate-700 border-slate-600 text-white" data-testid="input-screenshot-priority" />
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" className="text-slate-300" onClick={onDone} data-testid="button-screenshot-cancel">Cancel</Button>
        <Button type="submit" disabled={submitting || !file} data-testid="button-screenshot-submit">
          {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Upload className="w-4 h-4 mr-2" />}
          Add Screenshot
        </Button>
      </DialogFooter>
    </form>
  );
}

function ChangePasswordForm({ slug, onDone }: { slug: string; onDone: () => void }) {
  const { toast } = useToast();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const mutation = useMutation({
    mutationFn: async (password: string) => apiRequest("POST", `/api/custom-mcops/${slug}/password`, { password }),
    onSuccess: () => {
      toast({ title: "Password updated" });
      onDone();
    },
    onError: (e: any) => toast({ title: "Failed", description: e?.message || "", variant: "destructive" }),
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.length < 4) return toast({ title: "Too short", description: "At least 4 characters.", variant: "destructive" });
    if (pw !== pw2) return toast({ title: "Passwords do not match", variant: "destructive" });
    mutation.mutate(pw);
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <Label className="text-slate-300">New Password</Label>
        <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} className="bg-slate-700 border-slate-600 text-white" autoFocus data-testid="input-change-password" />
      </div>
      <div>
        <Label className="text-slate-300">Confirm Password</Label>
        <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} className="bg-slate-700 border-slate-600 text-white" data-testid="input-change-password-confirm" />
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" className="text-slate-300" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={mutation.isPending} data-testid="button-change-password-submit">
          {mutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
          Update
        </Button>
      </DialogFooter>
    </form>
  );
}

function EditFeedArticleForm({ slug, article, onDone }: { slug: string; article: FeedArticle; onDone: () => void }) {
  const { toast } = useToast();
  const initialBullets = (() => {
    const b = [...(article.summaryBullets || [])];
    while (b.length < 3) b.push("");
    return b.slice(0, 3);
  })();
  const initialImage = article.imageUrl?.startsWith("VIDEO:") ? "" : (article.imageUrl ?? "");
  const initialPriority = String(article.priorityOverride ?? article.basePriorityScore ?? article.priorityScore);

  const [title, setTitle] = useState(article.title);
  const [imageUrl, setImageUrl] = useState(initialImage);
  const [bullets, setBullets] = useState<string[]>(initialBullets);
  const [priority, setPriority] = useState(initialPriority);
  const [uploading, setUploading] = useState(false);
  const [storyText, setStoryText] = useState("");
  const [summarizing, setSummarizing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const summarizeReqId = useRef(0);

  const uploadFromFile = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const url = await uploadImage(file);
      setImageUrl(url);
      toast({ title: "Image uploaded" });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err?.message || "", variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [toast]);

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await uploadFromFile(file);
  };

  const handleImagePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) uploadFromFile(file);
        return;
      }
    }
  }, [uploadFromFile]);

  const summarizeText = useCallback(async (text: string) => {
    if (!text.trim() || text.trim().length < 50) return;
    const myId = ++summarizeReqId.current;
    setSummarizing(true);
    try {
      const res = await fetch(`/api/custom-mcops/${slug}/summarize-text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ text: text.trim(), headline: title }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Summarization failed");
      if (myId !== summarizeReqId.current) return;
      const out: string[] = (data.bullets || []).map((b: any) => String(b || "").trim());
      const valid = out.filter((b) => b.length > 0);
      if (valid.length < 2) {
        throw new Error("Model returned too few bullets — try again or paste more text.");
      }
      setBullets([valid[0] || "", valid[1] || "", valid[2] || ""]);
      toast({ title: "Bullets generated", description: "Review and edit, then save." });
    } catch (err: any) {
      if (myId === summarizeReqId.current) {
        toast({ title: "Summarization failed", description: err?.message || "", variant: "destructive" });
      }
    } finally {
      if (myId === summarizeReqId.current) setSummarizing(false);
    }
  }, [slug, title, toast]);

  const save = useMutation({
    mutationFn: async () => {
      const p = parseInt(priority, 10);
      const payload: any = {
        type: article.type,
        title,
        ogImageUrl: imageUrl || null,
        summaryBullets: bullets.map((b) => b.trim()).filter((b) => b.length > 0),
        priorityOverride: Number.isFinite(p) && p >= 1 && p <= 100 ? p : null,
      };
      return apiRequest("PATCH", `/api/custom-mcops/${slug}/feed-articles/${article.id}`, payload);
    },
    onSuccess: () => {
      toast({ title: "Saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/custom-mcops", slug, "feed"] });
      onDone();
    },
    onError: (e: any) => toast({ title: "Failed", description: e?.message || "", variant: "destructive" }),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return toast({ title: "Title required", variant: "destructive" });
    save.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <Label className="text-slate-300">Title</Label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="bg-slate-700 border-slate-600 text-white"
          data-testid="input-feed-article-title"
        />
      </div>

      <div>
        <Label className="text-slate-300">Image URL</Label>
        <div className="flex gap-2">
          <Input
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="https://..."
            className="bg-slate-700 border-slate-600 text-white flex-1"
            data-testid="input-feed-article-image"
          />
          <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading} data-testid="button-feed-article-upload">
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          </Button>
          <input ref={fileRef} type="file" accept="image/*" onChange={onFileChange} className="hidden" />
        </div>
        <div
          onPaste={handleImagePaste}
          tabIndex={0}
          className="mt-2 rounded-md border border-dashed border-slate-600 p-2 text-center text-[11px] text-slate-400 cursor-text focus:border-blue-500 focus:outline-none transition-colors"
          data-testid="paste-zone-feed-article-image"
        >
          <Clipboard className="w-3 h-3 inline mr-1 text-slate-500" />
          Click here, then paste an image (Ctrl+V / Cmd+V)
        </div>
        {imageUrl && (
          <img
            src={imageUrl}
            alt=""
            className="mt-2 rounded border border-slate-600 max-h-40 object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        )}
      </div>

      <div>
        <Label className="text-slate-300 mb-1 block flex items-center gap-1">
          <FileText className="w-3.5 h-3.5" />
          Paste article text to auto-generate bullets
        </Label>
        <Textarea
          value={storyText}
          onChange={(e) => setStoryText(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData?.getData("text");
            if (pasted && pasted.trim().length >= 50) {
              setTimeout(() => summarizeText(pasted), 50);
            }
          }}
          rows={4}
          placeholder="Paste the full article text here..."
          className="bg-slate-700 border-slate-600 text-white resize-none"
          data-testid="textarea-feed-article-source-text"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full mt-2 border-slate-600 text-slate-300"
          onClick={() => summarizeText(storyText)}
          disabled={summarizing || storyText.trim().length < 50}
          data-testid="button-feed-article-summarize"
        >
          {summarizing ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />Generating...</>
          ) : (
            <><Sparkles className="w-3.5 h-3.5 mr-1" />Generate Bullets</>
          )}
        </Button>
      </div>

      <div>
        <Label className="text-slate-300 mb-1 block flex items-center gap-1">
          Story Bullets (up to 3)
          {summarizing && <Loader2 className="w-3 h-3 animate-spin text-blue-400 ml-1" />}
        </Label>
        <div className="space-y-2">
          {bullets.map((b, i) => (
            <Textarea
              key={i}
              value={b}
              onChange={(e) => {
                const next = [...bullets];
                next[i] = e.target.value;
                setBullets(next);
              }}
              rows={2}
              placeholder={summarizing ? "Generating..." : `Bullet ${i + 1}`}
              disabled={summarizing}
              className="bg-slate-700 border-slate-600 text-white"
              data-testid={`textarea-feed-article-bullet-${i}`}
            />
          ))}
        </div>
      </div>

      <div>
        <Label className="text-slate-300">Priority Score (1-100)</Label>
        <Input
          type="number"
          min={1}
          max={100}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          className="bg-slate-700 border-slate-600 text-white"
          data-testid="input-feed-article-priority"
        />
        <p className="text-xs text-slate-500 mt-1">
          Sets a manual priority override on this story (clears when left blank or out of range).
        </p>
      </div>

      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={onDone} data-testid="button-feed-article-cancel">
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending} data-testid="button-feed-article-save">
          {save.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

interface McopOutlet {
  key: string;
  name: string;
  count: number;
  hidden: boolean;
}

function OutletsList({ slug }: { slug: string }) {
  const { toast } = useToast();
  const { data: outlets = [], isLoading } = useQuery<McopOutlet[]>({
    queryKey: ['/api/custom-mcops', slug, 'outlets'],
    queryFn: async () => {
      const res = await fetch(`/api/custom-mcops/${slug}/outlets`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
    enabled: !!slug,
  });

  const toggleOutlet = useMutation({
    mutationFn: async ({ key, hide }: { key: string; hide: boolean }) => {
      if (hide) {
        return apiRequest('POST', `/api/custom-mcops/${slug}/hidden`, { sourceType: 'outlet', sourceId: key });
      }
      return apiRequest('DELETE', `/api/custom-mcops/${slug}/hidden`, { sourceType: 'outlet', sourceId: key });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'outlets'] });
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'feed'] });
      queryClient.invalidateQueries({ queryKey: ['/api/custom-mcops', slug, 'hidden'] });
    },
    onError: () => toast({ title: 'Failed to update outlet', variant: 'destructive' }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
      </div>
    );
  }

  if (outlets.length === 0) {
    return <p className="text-sm text-slate-500 text-center py-6">No outlets configured.</p>;
  }

  return (
    <div className="overflow-y-auto -mx-2 px-2 space-y-1">
      {outlets.map((o) => {
        const display = !o.hidden;
        return (
          <label
            key={o.key}
            className="flex items-center justify-between gap-3 rounded-md px-3 py-2 bg-slate-700/40 hover-elevate cursor-pointer"
            data-testid={`row-outlet-${o.key}`}
          >
            <div className="flex items-center gap-3 min-w-0">
              <input
                type="checkbox"
                className="h-4 w-4 accent-blue-500 cursor-pointer"
                checked={display}
                disabled={toggleOutlet.isPending}
                onChange={(e) => toggleOutlet.mutate({ key: o.key, hide: !e.target.checked })}
                data-testid={`checkbox-outlet-${o.key}`}
              />
              <span className="text-sm text-white truncate" data-testid={`text-outlet-${o.key}`}>{o.name}</span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-xs text-slate-500 font-mono">{o.count}</span>
              <span className={`text-[10px] uppercase tracking-wider ${display ? 'text-emerald-400' : 'text-slate-500'}`}>
                {display ? 'Display' : 'Hidden'}
              </span>
            </div>
          </label>
        );
      })}
    </div>
  );
}
