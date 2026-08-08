import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Shield, ArrowLeft, Plus, Trash2, Edit, Save, X, Loader2, ExternalLink, RotateCcw, Image as ImageIcon, FileText, Hash, Upload } from "lucide-react";
import { Link } from "wouter";
import type { WarArticle } from "@shared/schema";

function compressImage(file: File, maxWidth = 1200, quality = 0.8): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const canvas = document.createElement("canvas");
      let w = img.width, h = img.height;
      if (w > maxWidth) {
        h = Math.round((h * maxWidth) / w);
        w = maxWidth;
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Canvas not supported"));
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error("Compression failed")),
        "image/jpeg",
        quality
      );
    };
    const objectUrl = URL.createObjectURL(file);
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("Failed to load image")); };
    img.src = objectUrl;
  });
}

function useImageUpload(onUploaded: (url: string) => void) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const uploadImage = useCallback(async (file: File) => {
    setUploading(true);
    console.log(`[WarAdmin Upload] Starting upload: ${file.name} (${file.size} bytes, ${file.type})`);
    try {
      if (file.size > 10 * 1024 * 1024) {
        throw new Error("File too large (max 10MB)");
      }
      let uploadBlob: Blob = file;
      let uploadName = file.name;
      if (file.size > 500 * 1024) {
        console.log(`[WarAdmin Upload] Compressing large image (${(file.size / 1024).toFixed(0)}KB)...`);
        uploadBlob = await compressImage(file);
        uploadName = file.name.replace(/\.[^.]+$/, ".jpg");
        console.log(`[WarAdmin Upload] Compressed to ${(uploadBlob.size / 1024).toFixed(0)}KB`);
      }
      const formData = new FormData();
      formData.append("image", uploadBlob, uploadName);
      const res = await fetch("/api/stream/upload-image", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      console.log(`[WarAdmin Upload] Response: ${res.status} ${res.statusText}`);
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        let errMsg = `Upload failed (${res.status})`;
        try {
          const errData = JSON.parse(errText);
          if (errData.error) errMsg = errData.error;
        } catch {}
        throw new Error(errMsg);
      }
      const data = await res.json();
      onUploaded(data.url);
      toast({ title: "Image uploaded" });
    } catch (err: any) {
      console.error("[WarAdmin Upload] Error:", err);
      const desc = err.name === "TypeError" 
        ? "Network error - the request couldn't reach the server. Try a smaller image or check your connection."
        : err.message;
      toast({ title: "Upload failed", description: desc, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }, [onUploaded, toast]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadImage(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [uploadImage]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) uploadImage(file);
        return;
      }
    }
  }, [uploadImage]);

  return { fileInputRef, uploading, handleFileChange, handlePaste };
}

interface WarSettings {
  feedFromMcop: boolean;
}

interface FeedArticle {
  id: string;
  title: string;
  url: string;
  imageUrl: string | null;
  summaryBullets: string[];
  source: string;
  priorityScore: number;
  priorityOverride: number | null;
  isWarArticle?: boolean;
  isMcopArticle?: boolean;
  hasOverride?: boolean;
  scrapedAt: string;
  articlePublishedAt?: string | null;
}

interface WarFeedResponse {
  topStories: FeedArticle[];
  feedFromMcop: boolean;
}

export default function WarAdmin() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const { toast } = useToast();

  useEffect(() => {
    fetch("/api/war/admin/status")
      .then(r => r.json())
      .then(data => setIsAuthenticated(data.authenticated))
      .catch(() => setIsAuthenticated(false));
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    try {
      const response = await apiRequest("POST", "/api/war/admin/auth", { password });
      if (response.ok) {
        setIsAuthenticated(true);
      } else {
        setAuthError("Invalid password");
      }
    } catch {
      setAuthError("Invalid password");
    }
  };

  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <Card className="w-full max-w-sm bg-slate-800 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <Shield className="w-5 h-5 text-amber-500" />
              War Dashboard Admin
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <Label className="text-slate-300">Password</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter admin password"
                  className="bg-slate-700 border-slate-600 text-white"
                  data-testid="input-war-admin-password"
                  autoFocus
                />
                {authError && (
                  <p className="text-red-400 text-xs mt-1" data-testid="text-war-admin-error">{authError}</p>
                )}
              </div>
              <Button type="submit" className="w-full" data-testid="button-war-admin-login">
                Login
              </Button>
              <Link href="/war">
                <Button variant="ghost" className="w-full text-slate-400" data-testid="button-war-admin-back">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to War Dashboard
                </Button>
              </Link>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <WarAdminPanel />;
}

interface WarScreenshot {
  id: string;
  caption: string;
  imageUrl: string;
  sourceLabel: string | null;
  priorityScore: number;
  createdAt: string;
}

function WarAdminPanel() {
  const { toast } = useToast();
  const [showAddForm, setShowAddForm] = useState(false);
  const [showAddScreenshot, setShowAddScreenshot] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const { data: settings } = useQuery<WarSettings>({
    queryKey: ['/api/war/settings'],
  });

  const { data: feedData, isLoading: feedLoading } = useQuery<WarFeedResponse>({
    queryKey: ['/api/war/feed'],
    refetchInterval: editingId ? false : 30000,
  });

  const { data: warArticles } = useQuery<WarArticle[]>({
    queryKey: ['/api/war/articles'],
  });

  const { data: screenshots = [] } = useQuery<WarScreenshot[]>({
    queryKey: ['/api/war/screenshots'],
  });

  const toggleFeedMutation = useMutation({
    mutationFn: async (feedFromMcop: boolean) => {
      await apiRequest("POST", "/api/war/settings", { feedFromMcop });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/war/settings'] });
      queryClient.invalidateQueries({ queryKey: ['/api/war/feed'] });
      toast({ title: "Settings updated" });
    },
  });

  const deleteWarArticleMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/war/articles/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/war/articles'] });
      queryClient.invalidateQueries({ queryKey: ['/api/war/feed'] });
      toast({ title: "Article removed" });
    },
  });

  const deleteScreenshotMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/war/screenshots/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/war/screenshots'] });
      toast({ title: "Screenshot removed" });
    },
  });

  const displayedArticles = feedData?.topStories ?? [];

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="bg-slate-800 border-b border-slate-700 px-4 py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Link href="/war">
            <Button size="icon" variant="ghost" data-testid="button-war-admin-back-dash">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          </Link>
          <Shield className="w-5 h-5 text-amber-500" />
          <h1 className="text-lg font-bold">War Dashboard Admin</h1>
        </div>
        <Button
          onClick={() => setShowAddForm(true)}
          data-testid="button-war-admin-add-article"
        >
          <Plus className="w-4 h-4 mr-2" />
          Submit Article
        </Button>
      </header>

      <div className="max-w-7xl mx-auto p-4 space-y-6">
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white text-sm">Feed Settings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-slate-200 text-sm font-medium">Feed from MCOP</Label>
                <p className="text-xs text-slate-400 mt-0.5">
                  When enabled, mirrors stories from the MCOP Stream page alongside War articles
                </p>
              </div>
              <Switch
                checked={settings?.feedFromMcop ?? true}
                onCheckedChange={(checked) => toggleFeedMutation.mutate(checked)}
                data-testid="switch-war-admin-feed-mcop"
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex gap-6">
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-3">
              Displayed Articles ({displayedArticles.length})
            </h2>
            <p className="text-xs text-slate-500 mb-4">
              Click any article to edit its headline, photo, bullets, or priority.
            </p>

            {feedLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
              </div>
            ) : displayedArticles.length > 0 ? (
              <div className="space-y-2">
                {displayedArticles.map((article, index) => (
                  <UnifiedArticleRow
                    key={article.id}
                    article={article}
                    rank={index + 1}
                    isEditing={editingId === article.id}
                    onEdit={() => setEditingId(article.id)}
                    onCancelEdit={() => setEditingId(null)}
                    onDelete={article.isWarArticle ? () => deleteWarArticleMutation.mutate(article.id) : undefined}
                    warArticleData={article.isWarArticle ? warArticles?.find(wa => wa.id === article.id) : undefined}
                  />
                ))}
              </div>
            ) : (
              <Card className="bg-slate-800/50 border-slate-700">
                <CardContent className="py-8 text-center text-slate-500 text-sm">
                  No articles in the War feed. {!settings?.feedFromMcop ? 'Enable "Feed from MCOP" or submit articles manually.' : 'Submit articles or wait for MCOP content.'}
                </CardContent>
              </Card>
            )}
          </div>

          <div className="w-80 flex-shrink-0">
            <div className="sticky top-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider">
                  X Column Screenshots ({screenshots.length})
                </h2>
                <Button
                  size="sm"
                  onClick={() => setShowAddScreenshot(true)}
                  data-testid="button-war-admin-add-screenshot"
                >
                  <Upload className="w-3 h-3 mr-1" />
                  Upload
                </Button>
              </div>
              <p className="text-xs text-slate-500 mb-4">
                Appear in the X column when "Other" is selected.
              </p>

              {screenshots.length > 0 ? (
                <div className="space-y-2">
                  {screenshots.map((ss) => (
                    <Card key={ss.id} className="bg-slate-800/50 border-slate-700" data-testid={`card-war-screenshot-${ss.id}`}>
                      <CardContent className="py-3 px-4">
                        <div className="flex items-start gap-3">
                          <img
                            src={ss.imageUrl}
                            alt={ss.caption}
                            className="w-16 h-12 object-cover rounded flex-shrink-0"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-white line-clamp-2" data-testid={`text-war-screenshot-caption-${ss.id}`}>{ss.caption}</p>
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
                            onClick={() => deleteScreenshotMutation.mutate(ss.id)}
                            data-testid={`button-delete-screenshot-${ss.id}`}
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
      </div>

      <Dialog open={showAddForm} onOpenChange={setShowAddForm}>
        <DialogContent className="sm:max-w-lg bg-slate-800 border-slate-700 text-white">
          <DialogHeader>
            <DialogTitle>Submit Article</DialogTitle>
          </DialogHeader>
          <WarArticleForm onSuccess={() => setShowAddForm(false)} />
        </DialogContent>
      </Dialog>

      <Dialog open={showAddScreenshot} onOpenChange={setShowAddScreenshot}>
        <DialogContent className="sm:max-w-lg bg-slate-800 border-slate-700 text-white">
          <DialogHeader>
            <DialogTitle>Upload Screenshot</DialogTitle>
          </DialogHeader>
          <WarScreenshotForm onSuccess={() => setShowAddScreenshot(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function UnifiedArticleRow({
  article,
  rank,
  isEditing,
  onEdit,
  onCancelEdit,
  onDelete,
  warArticleData,
}: {
  article: FeedArticle;
  rank: number;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onDelete?: () => void;
  warArticleData?: WarArticle;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (isEditing) {
    return (
      <Card className="bg-slate-800 border-slate-600">
        <CardContent className="pt-4">
          {article.isWarArticle && warArticleData ? (
            <WarArticleForm article={warArticleData} onSuccess={onCancelEdit} />
          ) : (
            <McopOverrideForm article={article} onSuccess={onCancelEdit} />
          )}
        </CardContent>
      </Card>
    );
  }

  const effectivePriority = article.priorityOverride ?? article.priorityScore;
  const imageToShow = article.imageUrl?.startsWith('VIDEO:') ? null : article.imageUrl;

  return (
    <Card
      className="bg-slate-800/50 border-slate-700 cursor-pointer transition-colors hover:bg-slate-700/60 hover:border-slate-600"
      onClick={onEdit}
      data-testid={`card-war-article-${article.id}`}
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
              <h3 className="text-sm font-medium text-white line-clamp-1" data-testid={`text-war-article-title-${article.id}`}>{article.title}</h3>
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
              {article.isWarArticle && (
                <Badge variant="outline" className="text-amber-400 border-amber-600 text-[10px]">WAR</Badge>
              )}
              {article.isMcopArticle && (
                <Badge variant="outline" className="text-blue-400 border-blue-600 text-[10px]">MCOP</Badge>
              )}
              {article.hasOverride && (
                <Badge variant="outline" className="text-green-400 border-green-600 text-[10px]">EDITED</Badge>
              )}
              <span className="text-xs text-slate-400">{article.source}</span>
              <span className="text-xs text-slate-500 font-mono">P:{effectivePriority}</span>
              {article.summaryBullets && article.summaryBullets.length > 0 && (
                <span className="text-xs text-slate-500">{article.summaryBullets.length} bullets</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <Button
              size="icon"
              variant="ghost"
              className="text-slate-400"
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              data-testid={`button-war-article-edit-${article.id}`}
            >
              <Edit className="w-3.5 h-3.5" />
            </Button>
            {onDelete && (
              confirmDelete ? (
                <div className="flex items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={(e) => { e.stopPropagation(); onDelete(); setConfirmDelete(false); }}
                    className="text-red-400"
                    data-testid={`button-war-article-confirm-delete-${article.id}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
                    data-testid={`button-war-article-cancel-delete-${article.id}`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ) : (
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
                  data-testid={`button-war-article-delete-${article.id}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              )
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function WarArticleForm({ article, onSuccess }: { article?: WarArticle; onSuccess: () => void }) {
  const { toast } = useToast();
  const [title, setTitle] = useState(article?.title ?? "");
  const [url, setUrl] = useState(article?.url ?? "");
  const [imageUrl, setImageUrl] = useState(article?.imageUrl ?? "");
  const [source, setSource] = useState(article?.source ?? "");
  const [priorityScore, setPriorityScore] = useState(String(article?.priorityScore ?? 50));
  const [bulletsText, setBulletsText] = useState(
    article?.summaryBullets?.join("\n") ?? ""
  );
  const { fileInputRef, uploading, handleFileChange, handlePaste } = useImageUpload(
    useCallback((uploadedUrl: string) => setImageUrl(uploadedUrl), [])
  );

  const mutation = useMutation({
    mutationFn: async (data: any) => {
      if (article) {
        await apiRequest("PATCH", `/api/war/articles/${article.id}`, data);
      } else {
        await apiRequest("POST", "/api/war/articles", data);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/war/articles'] });
      queryClient.invalidateQueries({ queryKey: ['/api/war/feed'] });
      toast({ title: article ? "Article updated" : "Article added" });
      onSuccess();
    },
    onError: () => {
      toast({ title: "Failed to save article", variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !url.trim()) return;

    const bullets = bulletsText.trim()
      ? bulletsText.split("\n").filter((b) => b.trim())
      : null;

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
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <Label className="text-slate-300 text-xs">Headline *</Label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Article headline"
          className="bg-slate-700 border-slate-600 text-white"
          data-testid="input-war-article-title"
          required
        />
      </div>
      <div>
        <Label className="text-slate-300 text-xs">Link *</Label>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
          className="bg-slate-700 border-slate-600 text-white"
          data-testid="input-war-article-url"
          required
        />
      </div>
      <div onPaste={handlePaste}>
        <Label className="text-slate-300 text-xs">Photo</Label>
        <Input
          value={imageUrl}
          onChange={(e) => setImageUrl(e.target.value)}
          placeholder="Paste image URL here"
          className="bg-slate-700 border-slate-600 text-white"
          data-testid="input-war-article-image"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
        />
        <div className="flex items-center gap-2 mt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            data-testid="button-war-article-upload-image"
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Upload className="w-4 h-4 mr-2" />}
            {uploading ? "Uploading..." : "Upload Photo"}
          </Button>
          <span className="text-[10px] text-slate-500">or paste an image from clipboard</span>
        </div>
        {imageUrl && (
          <img src={imageUrl} alt="" className="mt-2 w-32 h-20 object-cover rounded" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        )}
      </div>
      <div>
        <Label className="text-slate-300 text-xs">Source</Label>
        <Input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="e.g. CNN"
          className="bg-slate-700 border-slate-600 text-white"
          data-testid="input-war-article-source"
        />
      </div>
      <div>
        <Label className="text-slate-300 text-xs">Priority (1-100)</Label>
        <Input
          type="number"
          value={priorityScore}
          onChange={(e) => setPriorityScore(e.target.value)}
          min="1"
          max="100"
          className="bg-slate-700 border-slate-600 text-white w-24"
          data-testid="input-war-article-priority"
        />
      </div>
      <div>
        <Label className="text-slate-300 text-xs">Summary Bullets (one per line)</Label>
        <Textarea
          value={bulletsText}
          onChange={(e) => setBulletsText(e.target.value)}
          placeholder="Enter summary bullets, one per line"
          rows={3}
          className="bg-slate-700 border-slate-600 text-white resize-none"
          data-testid="input-war-article-bullets"
        />
      </div>
      <div className="flex gap-2 justify-end">
        <Button
          type="button"
          variant="ghost"
          onClick={onSuccess}
          data-testid="button-war-article-cancel"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={mutation.isPending || !title.trim() || !url.trim()}
          data-testid="button-war-article-submit"
        >
          {mutation.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
          ) : (
            <Save className="w-4 h-4 mr-2" />
          )}
          {article ? "Update" : "Add Article"}
        </Button>
      </div>
    </form>
  );
}

function McopOverrideForm({ article, onSuccess }: { article: FeedArticle; onSuccess: () => void }) {
  const { toast } = useToast();
  const [title, setTitle] = useState(article.title);
  const [imageUrl, setImageUrl] = useState(
    article.imageUrl?.startsWith('VIDEO:') ? '' : (article.imageUrl ?? '')
  );
  const [priorityScore, setPriorityScore] = useState(
    String(article.priorityOverride ?? article.priorityScore)
  );
  const [bulletsText, setBulletsText] = useState(
    article.summaryBullets?.join("\n") ?? ""
  );
  const { fileInputRef, uploading, handleFileChange, handlePaste } = useImageUpload(
    useCallback((uploadedUrl: string) => setImageUrl(uploadedUrl), [])
  );

  const saveMutation = useMutation({
    mutationFn: async (data: any) => {
      await apiRequest("PUT", `/api/war/overrides/${article.id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/war/feed'] });
      queryClient.invalidateQueries({ queryKey: ['/api/war/overrides'] });
      toast({ title: "Override saved" });
      onSuccess();
    },
    onError: () => {
      toast({ title: "Failed to save override", variant: "destructive" });
    },
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/war/overrides/${article.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/war/feed'] });
      queryClient.invalidateQueries({ queryKey: ['/api/war/overrides'] });
      toast({ title: "Override removed, using original MCOP data" });
      onSuccess();
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const bullets = bulletsText.trim()
      ? bulletsText.split("\n").filter((b) => b.trim())
      : null;

    saveMutation.mutate({
      title: title.trim() || null,
      imageUrl: imageUrl.trim() || null,
      summaryBullets: bullets,
      priorityScore: parseInt(priorityScore) || null,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex items-center justify-between mb-2">
        <Badge variant="outline" className="text-blue-400 border-blue-600 text-[10px]">EDITING MCOP ARTICLE</Badge>
        {article.hasOverride && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => resetMutation.mutate()}
            disabled={resetMutation.isPending}
            data-testid={`button-war-reset-override-${article.id}`}
          >
            <RotateCcw className="w-3 h-3 mr-1" />
            Reset to Original
          </Button>
        )}
      </div>
      <div>
        <Label className="text-slate-300 text-xs flex items-center gap-1">
          <FileText className="w-3 h-3" /> Headline
        </Label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Override headline"
          className="bg-slate-700 border-slate-600 text-white"
          data-testid={`input-war-override-title-${article.id}`}
        />
      </div>
      <div>
        <Label className="text-slate-300 text-xs flex items-center gap-1">
          <ImageIcon className="w-3 h-3" /> Photo
        </Label>
        <div onPaste={handlePaste}>
          <Input
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="Paste image URL here"
            className="bg-slate-700 border-slate-600 text-white"
            data-testid={`input-war-override-image-${article.id}`}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />
          <div className="flex items-center gap-2 mt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              data-testid={`button-war-override-upload-image-${article.id}`}
            >
              {uploading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Upload className="w-4 h-4 mr-2" />}
              {uploading ? "Uploading..." : "Upload Photo"}
            </Button>
            <span className="text-[10px] text-slate-500">or paste an image from clipboard</span>
          </div>
          {imageUrl && (
            <img src={imageUrl} alt="" className="mt-2 w-32 h-20 object-cover rounded" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          )}
        </div>
      </div>
      <div>
        <Label className="text-slate-300 text-xs flex items-center gap-1">
          <Hash className="w-3 h-3" /> Priority (1-100)
        </Label>
        <Input
          type="number"
          value={priorityScore}
          onChange={(e) => setPriorityScore(e.target.value)}
          min="1"
          max="100"
          className="bg-slate-700 border-slate-600 text-white w-24"
          data-testid={`input-war-override-priority-${article.id}`}
        />
      </div>
      <div>
        <Label className="text-slate-300 text-xs">Summary Bullets (one per line)</Label>
        <Textarea
          value={bulletsText}
          onChange={(e) => setBulletsText(e.target.value)}
          placeholder="Override summary bullets"
          rows={3}
          className="bg-slate-700 border-slate-600 text-white resize-none"
          data-testid={`input-war-override-bullets-${article.id}`}
        />
      </div>
      <div className="flex gap-2 justify-end">
        <Button
          type="button"
          variant="ghost"
          onClick={onSuccess}
          data-testid={`button-war-override-cancel-${article.id}`}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={saveMutation.isPending}
          data-testid={`button-war-override-save-${article.id}`}
        >
          {saveMutation.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
          ) : (
            <Save className="w-4 h-4 mr-2" />
          )}
          Save Override
        </Button>
      </div>
    </form>
  );
}

function WarScreenshotForm({ onSuccess }: { onSuccess: () => void }) {
  const { toast } = useToast();
  const [linkUrl, setLinkUrl] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (file: File) => {
    setSelectedFile(file);
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) handleFileSelect(file);
        return;
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) {
      toast({ title: "Please select an image", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      let uploadBlob: Blob = selectedFile;
      let uploadName = selectedFile.name;
      if (selectedFile.size > 500 * 1024) {
        uploadBlob = await compressImage(selectedFile);
        uploadName = selectedFile.name.replace(/\.[^.]+$/, ".jpg");
      }

      const formData = new FormData();
      formData.append("image", uploadBlob, uploadName);
      formData.append("caption", "Screenshot");
      if (linkUrl.trim()) formData.append("linkUrl", linkUrl.trim());

      const res = await fetch("/api/war/screenshots", {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Upload failed (${res.status})`);
      }

      queryClient.invalidateQueries({ queryKey: ['/api/war/screenshots'] });
      toast({ title: "Screenshot uploaded" });
      onSuccess();
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4" onPaste={handlePaste}>
      <div>
        <Label className="text-slate-300 text-sm">Screenshot Image</Label>
        <div className="mt-1">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFileSelect(file);
            }}
            data-testid="input-screenshot-file"
          />
          {previewUrl ? (
            <div className="relative">
              <img src={previewUrl} alt="Preview" className="w-full max-h-48 object-contain rounded bg-slate-700" />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="absolute top-1 right-1 bg-black/50"
                onClick={() => { setSelectedFile(null); setPreviewUrl(null); }}
                data-testid="button-screenshot-clear"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          ) : (
            <div
              className="border-2 border-dashed border-slate-600 rounded-lg p-6 text-center cursor-pointer hover:border-slate-500 transition-colors"
              onClick={() => fileInputRef.current?.click()}
              data-testid="button-screenshot-select"
            >
              <ImageIcon className="w-8 h-8 text-slate-500 mx-auto mb-2" />
              <p className="text-sm text-slate-400">Click to select or paste a screenshot</p>
            </div>
          )}
        </div>
      </div>

      <div>
        <Label className="text-slate-300 text-sm">Link URL (optional)</Label>
        <Input
          value={linkUrl}
          onChange={(e) => setLinkUrl(e.target.value)}
          placeholder="https://x.com/... or any URL"
          className="bg-slate-700 border-slate-600 text-white mt-1"
          data-testid="input-screenshot-link-url"
        />
        <p className="text-[10px] text-slate-500 mt-1">Clicking the screenshot on the War Dashboard will open this link</p>
      </div>

      <Button
        type="submit"
        className="w-full"
        disabled={uploading || !selectedFile}
        data-testid="button-screenshot-submit"
      >
        {uploading ? (
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
        ) : (
          <Upload className="w-4 h-4 mr-2" />
        )}
        {uploading ? "Uploading..." : "Upload Screenshot"}
      </Button>
    </form>
  );
}
