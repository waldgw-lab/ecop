import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Link } from "wouter";
import ThemeToggle from "@/components/ThemeToggle";
import { Textarea } from "@/components/ui/textarea";
import { Shield, ArrowLeft, Upload, Image, Clipboard, Save, ExternalLink, Loader2, ChevronDown, ChevronUp, CheckCircle, XCircle, Link as LinkIcon, FileText, Sparkles, Pencil, Check, X, Clock, Layers, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

interface StreamHeadline {
  id: string;
  title: string;
  url: string;
  source: string;
  imageUrl: string | null;
  summaryBullets: string[] | null;
  priorityScore: number;
  priorityOverride: number | null;
  depreciatedPriority: number;
  type: 'scraped' | 'manual';
}

interface NextUpStory {
  id: string;
  title: string;
  url: string;
  source: string;
  priorityScore: number;
  priorityOverride: number | null;
  depreciatedPriority: number;
  type: 'scraped' | 'manual';
}

interface StreamData {
  topStories: StreamHeadline[];
  nextUpStories: NextUpStory[];
  truthSocialPosts: unknown[];
  xPosts: unknown[];
  firstAlerts: unknown[];
}

interface EditState {
  imageUrl: string;
  bullets: string[];
}

function StoryEditor({ story, index }: { story: StreamHeadline; index: number }) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isVideo = story.imageUrl?.startsWith("VIDEO:");
  const currentImageUrl = isVideo ? story.imageUrl?.replace("VIDEO:", "") : story.imageUrl;

  const initialState: EditState = (() => {
    const existingBullets = story.summaryBullets || [];
    return {
      imageUrl: currentImageUrl || "",
      bullets: [
        existingBullets[0] || "",
        existingBullets[1] || "",
        existingBullets[2] || "",
      ],
    };
  })();

  const [editState, setEditState] = useState<EditState>(initialState);
  const [uploading, setUploading] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [storyText, setStoryText] = useState("");

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(story.title);
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlDraft, setUrlDraft] = useState(story.url);
  const [editingPriority, setEditingPriority] = useState(false);
  const [priorityDraft, setPriorityDraft] = useState<string>(
    String(story.priorityOverride ?? story.priorityScore)
  );

  const summarizeText = useCallback(async (text: string) => {
    if (!text.trim() || text.trim().length < 50) return;
    setSummarizing(true);
    try {
      const res = await fetch("/api/stream/summarize-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ text: text.trim(), headline: story.title }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Summarization failed");
      const bullets: string[] = data.bullets || [];
      setEditState((prev) => ({
        ...prev,
        bullets: [
          bullets[0] || "",
          bullets[1] || "",
          bullets[2] || "",
        ],
      }));
      toast({ title: "Bullets generated", description: "Review and edit as needed, then save." });
    } catch (err: any) {
      toast({ title: "Summarization failed", description: err.message, variant: "destructive" });
    } finally {
      setSummarizing(false);
    }
  }, [story.title, toast]);

  const effectivePriority = story.priorityOverride ?? story.priorityScore;

  const titleMutation = useMutation({
    mutationFn: async (newTitle: string) => {
      await apiRequest("PATCH", `/api/admin/headlines/${story.id}/title`, {
        title: newTitle,
        type: story.type,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stream"] });
      setEditingTitle(false);
      toast({ title: "Headline updated" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to update headline", description: err.message, variant: "destructive" });
    },
  });

  const urlMutation = useMutation({
    mutationFn: async (newUrl: string) => {
      await apiRequest("PATCH", `/api/headlines/${story.id}/url`, {
        url: newUrl,
        type: story.type,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stream"] });
      setEditingUrl(false);
      toast({ title: "URL updated" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to update URL", description: err.message, variant: "destructive" });
    },
  });

  const priorityMutation = useMutation({
    mutationFn: async (newPriority: number | null) => {
      await apiRequest("PATCH", `/api/admin/headlines/${story.id}/priority`, {
        priorityOverride: newPriority,
        type: story.type,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stream"] });
      setEditingPriority(false);
      toast({ title: "Priority updated" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to update priority", description: err.message, variant: "destructive" });
    },
  });

  const blockMutation = useMutation({
    mutationFn: async () => {
      await apiRequest('DELETE', `/api/admin/headlines/${story.id}?type=${story.type}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stream"] });
      toast({ title: "Story blocked", description: "Removed and blocked from future scrapes" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to block story", description: err.message, variant: "destructive" });
    },
  });

  const handleBlock = () => {
    if (confirm('Block this story? It will be removed and prevented from appearing again.')) {
      blockMutation.mutate();
    }
  };

  const uploadImage = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("image", file);
      const res = await fetch("/api/stream/upload-image", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      setEditState((prev) => ({ ...prev, imageUrl: data.url }));
      toast({ title: "Image uploaded", description: "Image URL has been set." });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }, [toast]);

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

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {};
      if (editState.imageUrl !== initialState.imageUrl) {
        payload.ogImageUrl = editState.imageUrl || null;
      }
      const bulletsChanged = editState.bullets.some((b, i) => b !== initialState.bullets[i]);
      if (bulletsChanged) {
        payload.summaryBullets = editState.bullets.filter((b) => b.trim() !== "");
      }
      await apiRequest("PATCH", `/api/headlines/${story.id}/stream-media`, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stream"] });
      toast({ title: "Saved", description: `Updated media for "${story.title.substring(0, 50)}..."` });
    },
    onError: (err: any) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const updateBullet = (index: number, value: string) => {
    setEditState((prev) => {
      const newBullets = [...prev.bullets];
      newBullets[index] = value;
      return { ...prev, bullets: newBullets };
    });
  };

  return (
    <Card className="bg-slate-800 border-slate-700" data-testid={`story-card-${story.id}`}>
      <CardHeader className="pb-2 space-y-2">
        <div className="flex items-center gap-2 text-[10px] text-slate-500 font-mono">
          <span>#{index + 1}</span>
          <span>|</span>
          <span>{story.type}</span>
        </div>

        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            {editingTitle ? (
              <div className="flex items-center gap-1">
                <Input
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  className="text-sm bg-slate-700 border-slate-600 text-white h-8"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') titleMutation.mutate(titleDraft);
                    if (e.key === 'Escape') { setEditingTitle(false); setTitleDraft(story.title); }
                  }}
                  data-testid={`input-title-${story.id}`}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-green-400 flex-shrink-0"
                  onClick={() => titleMutation.mutate(titleDraft)}
                  disabled={titleMutation.isPending || titleDraft.trim() === ''}
                  data-testid={`button-save-title-${story.id}`}
                >
                  {titleMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-slate-400 flex-shrink-0"
                  onClick={() => { setEditingTitle(false); setTitleDraft(story.title); }}
                  data-testid={`button-cancel-title-${story.id}`}
                >
                  <X className="w-3 h-3" />
                </Button>
              </div>
            ) : (
              <div className="flex items-start gap-1 group">
                <CardTitle className="text-white text-sm leading-snug" data-testid={`story-title-${story.id}`}>
                  {story.title}
                </CardTitle>
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-slate-500 flex-shrink-0 invisible group-hover:visible"
                  onClick={() => setEditingTitle(true)}
                  data-testid={`button-edit-title-${story.id}`}
                >
                  <Pencil className="w-3 h-3" />
                </Button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <a
              href={story.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-slate-400"
              data-testid={`story-link-${story.id}`}
            >
              <ExternalLink className="w-4 h-4" />
            </a>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-red-400 hover:text-red-300"
              onClick={handleBlock}
              disabled={blockMutation.isPending}
              title="Block story from stream"
              data-testid={`button-block-${story.id}`}
            >
              {blockMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="secondary" className="text-xs" data-testid={`story-source-${story.id}`}>
            {story.source}
          </Badge>

          {editingPriority ? (
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={1}
                max={100}
                value={priorityDraft}
                onChange={(e) => setPriorityDraft(e.target.value)}
                className="w-16 h-6 text-xs bg-slate-700 border-slate-600 text-white px-1"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const val = parseInt(priorityDraft);
                    if (val >= 1 && val <= 100) priorityMutation.mutate(val);
                  }
                  if (e.key === 'Escape') { setEditingPriority(false); setPriorityDraft(String(effectivePriority)); }
                }}
                data-testid={`input-priority-${story.id}`}
              />
              <Button
                size="icon"
                variant="ghost"
                className="text-green-400 h-6 w-6"
                onClick={() => {
                  const val = parseInt(priorityDraft);
                  if (val >= 1 && val <= 100) priorityMutation.mutate(val);
                }}
                disabled={priorityMutation.isPending}
                data-testid={`button-save-priority-${story.id}`}
              >
                {priorityMutation.isPending ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Check className="w-2.5 h-2.5" />}
              </Button>
              {story.priorityOverride !== null && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-red-400 h-6 w-6"
                  onClick={() => priorityMutation.mutate(null)}
                  disabled={priorityMutation.isPending}
                  title="Clear override"
                  data-testid={`button-clear-priority-${story.id}`}
                >
                  <X className="w-2.5 h-2.5" />
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                className="text-slate-400 h-6 w-6"
                onClick={() => { setEditingPriority(false); setPriorityDraft(String(effectivePriority)); }}
                data-testid={`button-cancel-priority-${story.id}`}
              >
                <X className="w-2.5 h-2.5" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1 group cursor-pointer" onClick={() => setEditingPriority(true)}>
              <Badge variant="outline" className="text-xs border-slate-600 text-slate-300" data-testid={`story-priority-${story.id}`}>
                Priority: {effectivePriority}
              </Badge>
              {story.priorityOverride !== null && (
                <Badge variant="outline" className="text-xs border-amber-600 text-amber-400">
                  Override
                </Badge>
              )}
              {story.depreciatedPriority !== effectivePriority && (
                <Badge variant="outline" className="text-xs border-slate-600 text-slate-500">
                  <Clock className="w-2.5 h-2.5 mr-0.5" />
                  Eff: {story.depreciatedPriority}
                </Badge>
              )}
              <Pencil className="w-2.5 h-2.5 text-slate-500 invisible group-hover:visible" />
            </div>
          )}
        </div>

        {editingUrl ? (
          <div className="flex items-center gap-1">
            <Input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              className="text-[11px] bg-slate-700 border-slate-600 text-slate-300 h-7"
              placeholder="https://..."
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') urlMutation.mutate(urlDraft);
                if (e.key === 'Escape') { setEditingUrl(false); setUrlDraft(story.url); }
              }}
              data-testid={`input-url-${story.id}`}
            />
            <Button
              size="icon"
              variant="ghost"
              className="text-green-400 flex-shrink-0"
              onClick={() => urlMutation.mutate(urlDraft)}
              disabled={urlMutation.isPending || urlDraft.trim() === ''}
              data-testid={`button-save-url-${story.id}`}
            >
              {urlMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="text-slate-400 flex-shrink-0"
              onClick={() => { setEditingUrl(false); setUrlDraft(story.url); }}
              data-testid={`button-cancel-url-${story.id}`}
            >
              <X className="w-3 h-3" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1 group">
            <span className="text-[10px] text-slate-500 truncate max-w-[400px]" title={story.url} data-testid={`story-url-${story.id}`}>
              {story.url}
            </span>
            <Button
              size="icon"
              variant="ghost"
              className="text-slate-500 flex-shrink-0 invisible group-hover:visible h-5 w-5"
              onClick={() => setEditingUrl(true)}
              data-testid={`button-edit-url-${story.id}`}
            >
              <Pencil className="w-2.5 h-2.5" />
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex gap-4 flex-col sm:flex-row">
          <div className="w-full sm:w-[200px] flex-shrink-0 space-y-2">
            <div
              className="w-full h-[130px] rounded-md overflow-hidden bg-slate-700 flex items-center justify-center"
              data-testid={`story-image-preview-${story.id}`}
            >
              {editState.imageUrl ? (
                <img
                  src={editState.imageUrl}
                  alt=""
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : (
                <Image className="w-8 h-8 text-slate-500" />
              )}
            </div>

            <Input
              placeholder="Paste image URL..."
              value={editState.imageUrl}
              onChange={(e) => setEditState((prev) => ({ ...prev, imageUrl: e.target.value }))}
              className="text-xs bg-slate-700 border-slate-600 text-white placeholder:text-slate-500"
              data-testid={`input-image-url-${story.id}`}
            />

            <div className="flex gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileChange}
                data-testid={`input-file-${story.id}`}
              />
              <Button
                variant="outline"
                size="sm"
                className="flex-1 border-slate-600 text-slate-300"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                data-testid={`button-upload-${story.id}`}
              >
                {uploading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Upload className="w-3 h-3 mr-1" />}
                Upload
              </Button>
            </div>

            <div
              onPaste={handlePaste}
              tabIndex={0}
              className="rounded-md border border-dashed border-slate-600 p-2 text-center text-[11px] text-slate-500 cursor-text focus:border-blue-500 focus:outline-none transition-colors"
              data-testid={`paste-zone-${story.id}`}
            >
              <Clipboard className="w-3 h-3 mx-auto mb-0.5 text-slate-500" />
              Paste screenshot here (Ctrl+V)
            </div>

            <div className="space-y-1">
              <div className="text-[10px] text-slate-500 flex items-center gap-1">
                <FileText className="w-2.5 h-2.5" />
                Paste story text to auto-generate bullets
              </div>
              <Textarea
                placeholder="Paste article text here..."
                value={storyText}
                onChange={(e) => setStoryText(e.target.value)}
                onPaste={(e) => {
                  const pasted = e.clipboardData?.getData("text");
                  if (pasted && pasted.trim().length >= 50) {
                    setTimeout(() => summarizeText(pasted), 50);
                  }
                }}
                className="text-[11px] bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 resize-none h-[72px]"
                data-testid={`textarea-story-text-${story.id}`}
              />
              <Button
                variant="outline"
                size="sm"
                className="w-full border-slate-600 text-slate-300 text-[11px]"
                onClick={() => summarizeText(storyText)}
                disabled={summarizing || storyText.trim().length < 50}
                data-testid={`button-summarize-${story.id}`}
              >
                {summarizing ? (
                  <><Loader2 className="w-3 h-3 animate-spin mr-1" />Generating...</>
                ) : (
                  <><Sparkles className="w-3 h-3 mr-1" />Generate Bullets</>
                )}
              </Button>
            </div>
          </div>

          <div className="flex-1 space-y-2">
            <div className="text-xs text-slate-400 font-medium flex items-center gap-1">
              Summary Bullets
              {summarizing && <Loader2 className="w-3 h-3 animate-spin text-blue-400 ml-1" />}
            </div>
            {[0, 1, 2].map((idx) => (
              <Input
                key={idx}
                placeholder={summarizing ? "Generating..." : idx === 0 ? "What changed / the big announcement..." : idx === 1 ? "Background context..." : "Supplemental information..."}
                value={editState.bullets[idx]}
                onChange={(e) => updateBullet(idx, e.target.value)}
                disabled={summarizing}
                className="text-xs bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 disabled:opacity-50"
                data-testid={`input-bullet-${story.id}-${idx}`}
              />
            ))}

            <div className="flex justify-end pt-1">
              <Button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                data-testid={`button-save-${story.id}`}
              >
                {saveMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-1" />
                ) : (
                  <Save className="w-4 h-4 mr-1" />
                )}
                Save
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function UploadTestPanel() {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ url: string; success: boolean; error?: string } | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const testFileRef = useRef<HTMLInputElement>(null);

  const doUpload = useCallback(async (file: File) => {
    setUploading(true);
    setUploadResult(null);
    try {
      const formData = new FormData();
      formData.append("image", file);
      const res = await fetch("/api/stream/upload-image", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setUploadResult({ url: data.url, success: true });
      toast({ title: "Upload succeeded", description: data.url });
    } catch (err: any) {
      setUploadResult({ url: "", success: false, error: err.message });
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }, [toast]);

  const handleTestFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) doUpload(file);
    if (testFileRef.current) testFileRef.current.value = "";
  }, [doUpload]);

  const handleTestPaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) doUpload(file);
        return;
      }
    }
  }, [doUpload]);

  const handleUrlSubmit = useCallback(async () => {
    if (!urlInput.trim()) return;
    setUploading(true);
    setUploadResult(null);
    try {
      const res = await fetch(urlInput.trim());
      if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
      const blob = await res.blob();
      const ext = urlInput.split('.').pop()?.split('?')[0] || 'jpg';
      const file = new File([blob], `url-image.${ext}`, { type: blob.type || 'image/jpeg' });
      await doUpload(file);
    } catch (err: any) {
      setUploadResult({ url: "", success: false, error: err.message });
      toast({ title: "URL fetch failed", description: err.message, variant: "destructive" });
      setUploading(false);
    }
  }, [urlInput, doUpload, toast]);

  return (
    <Card className="bg-slate-800 border-slate-700 mb-4" data-testid="upload-test-panel">
      <CardHeader
        className="flex flex-row items-center justify-between gap-3 pb-2 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
        data-testid="button-toggle-upload-test"
      >
        <CardTitle className="text-white text-sm flex items-center gap-2">
          <Upload className="w-4 h-4 text-blue-400" />
          Upload Test Panel
        </CardTitle>
        {expanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </CardHeader>
      {expanded && (
        <CardContent className="pt-0 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-2">
              <div className="text-xs text-slate-400 font-medium flex items-center gap-1">
                <LinkIcon className="w-3 h-3" /> From URL
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="https://example.com/image.jpg"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  className="text-xs bg-slate-700 border-slate-600 text-white placeholder:text-slate-500"
                  data-testid="input-test-url"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="border-slate-600 text-slate-300 flex-shrink-0"
                  onClick={handleUrlSubmit}
                  disabled={uploading || !urlInput.trim()}
                  data-testid="button-test-url-upload"
                >
                  {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-xs text-slate-400 font-medium flex items-center gap-1">
                <Upload className="w-3 h-3" /> File Upload
              </div>
              <input
                ref={testFileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleTestFile}
                data-testid="input-test-file"
              />
              <Button
                variant="outline"
                className="w-full border-slate-600 text-slate-300"
                onClick={() => testFileRef.current?.click()}
                disabled={uploading}
                data-testid="button-test-file-upload"
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Upload className="w-4 h-4 mr-2" />}
                Choose File
              </Button>
            </div>

            <div className="space-y-2">
              <div className="text-xs text-slate-400 font-medium flex items-center gap-1">
                <Clipboard className="w-3 h-3" /> Clipboard Paste
              </div>
              <div
                onPaste={handleTestPaste}
                tabIndex={0}
                className="rounded-md border border-dashed border-slate-600 p-4 text-center text-xs text-slate-500 cursor-text focus:border-blue-500 focus:outline-none transition-colors"
                data-testid="paste-zone-test"
              >
                <Clipboard className="w-4 h-4 mx-auto mb-1 text-slate-500" />
                Click here, then Ctrl+V
              </div>
            </div>
          </div>

          {uploadResult && (
            <div className={`rounded-md p-3 text-sm ${uploadResult.success ? 'bg-green-900/30 border border-green-700' : 'bg-red-900/30 border border-red-700'}`} data-testid="upload-test-result">
              <div className="flex items-center gap-2 mb-2">
                {uploadResult.success ? (
                  <><CheckCircle className="w-4 h-4 text-green-400" /><span className="text-green-400 font-medium">Upload Succeeded</span></>
                ) : (
                  <><XCircle className="w-4 h-4 text-red-400" /><span className="text-red-400 font-medium">Upload Failed</span></>
                )}
              </div>
              {uploadResult.success && (
                <div className="space-y-2">
                  <div className="text-xs text-slate-400 break-all" data-testid="text-upload-path">Path: {uploadResult.url}</div>
                  <div className="w-[200px] h-[130px] rounded-md overflow-hidden bg-slate-700">
                    <img src={uploadResult.url} alt="Uploaded test" className="w-full h-full object-cover" data-testid="img-upload-preview" />
                  </div>
                </div>
              )}
              {uploadResult.error && (
                <div className="text-xs text-red-300 break-all" data-testid="text-upload-error">{uploadResult.error}</div>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function NextUpQueue({ stories }: { stories: NextUpStory[] }) {
  if (stories.length === 0) return null;

  return (
    <Card className="bg-slate-800/60 border-slate-700 mt-6" data-testid="next-up-queue">
      <CardHeader className="pb-2">
        <CardTitle className="text-slate-400 text-xs font-medium uppercase tracking-wider flex items-center gap-2">
          <Clock className="w-3.5 h-3.5" />
          Next in Queue
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        {stories.map((story, i) => {
          const eff = story.priorityOverride ?? story.priorityScore;
          return (
            <div
              key={story.id}
              className="flex items-center gap-3 p-2 rounded-md bg-slate-700/40"
              data-testid={`next-up-story-${story.id}`}
            >
              <span className="text-[10px] text-slate-500 font-mono w-4 flex-shrink-0">#{i + 9}</span>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-slate-300 truncate" data-testid={`next-up-title-${story.id}`}>{story.title}</div>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  <span className="text-[10px] text-slate-500">{story.source}</span>
                  <span className="text-[10px] text-slate-500">P: {eff}</span>
                  {story.depreciatedPriority !== eff && (
                    <span className="text-[10px] text-slate-600">Eff: {story.depreciatedPriority}</span>
                  )}
                </div>
              </div>
              <a
                href={story.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-slate-500 flex-shrink-0"
                data-testid={`next-up-link-${story.id}`}
              >
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export default function StreamManager() {
  const { data: streamData, isLoading } = useQuery<StreamData>({
    queryKey: ["/api/stream"],
  });

  const stories = streamData?.topStories || [];
  const nextUpStories = streamData?.nextUpStories || [];

  const { data: clusteringStatus } = useQuery<{ enabled: boolean }>({
    queryKey: ['/api/clusters/enabled'],
  });
  const clusteringEnabled = clusteringStatus?.enabled ?? true;

  const toggleClusteringMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      return apiRequest('POST', '/api/clusters/toggle', { enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/clusters/enabled'] });
      queryClient.invalidateQueries({ queryKey: ['/api/stream'] });
    },
  });

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="sticky top-0 z-50 bg-slate-900/95 backdrop-blur border-b border-slate-700 px-4 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link href="/team" data-testid="link-back-team">
              <Button variant="ghost" size="icon" className="text-slate-400">
                <ArrowLeft className="w-4 h-4" />
              </Button>
            </Link>
            <Shield className="w-5 h-5 text-blue-400" />
            <h1 className="text-lg font-bold" data-testid="text-page-title">Stream Manager</h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-slate-400" />
              <Label htmlFor="clustering-toggle" className="text-xs text-slate-300 cursor-pointer whitespace-nowrap">
                Headline AI Clustering
              </Label>
              <Switch
                id="clustering-toggle"
                checked={clusteringEnabled}
                onCheckedChange={(checked) => toggleClusteringMutation.mutate(checked)}
                disabled={toggleClusteringMutation.isPending}
                data-testid="toggle-headline-clustering"
              />
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-4">
        <UploadTestPanel />
        {isLoading ? (
          <div className="flex items-center justify-center py-20" data-testid="loading-indicator">
            <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
            <span className="ml-2 text-slate-400">Loading stream data...</span>
          </div>
        ) : stories.length === 0 ? (
          <div className="text-center py-20 text-slate-500" data-testid="empty-state">
            No stories in the stream rotation.
          </div>
        ) : (
          <ScrollArea className="h-[calc(100vh-80px)]">
            <div className="space-y-4 pb-8" data-testid="stories-list">
              {stories.map((story, i) => (
                <StoryEditor key={story.id} story={story} index={i} />
              ))}
              <NextUpQueue stories={nextUpStories} />
            </div>
          </ScrollArea>
        )}
      </main>
    </div>
  );
}
