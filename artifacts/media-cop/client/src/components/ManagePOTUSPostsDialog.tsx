import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Eye, EyeOff, Plus, Send, Loader2, Upload, X, ImageOff } from "lucide-react";
import type { TruthSocialPost } from "@shared/schema";
import { cleanTruthContent } from "@/lib/cleanTruthContent";

function formatTime(date: Date | string): string {
  const d = new Date(date);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York'
  });
}

async function compressImage(file: File | Blob, maxWidth = 1200, quality = 0.8): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width;
      let h = img.height;
      if (w > maxWidth) {
        h = Math.round((h * maxWidth) / w);
        w = maxWidth;
      }
      const canvas = document.createElement("canvas");
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

export function ManagePOTUSPostsDialog() {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'manage' | 'add'>('manage');
  const [content, setContent] = useState('');
  const [postedAt, setPostedAt] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const { data: allPosts = [], isLoading } = useQuery<TruthSocialPost[]>({
    queryKey: ['/api/truth-social-posts/all'],
    enabled: open,
  });

  const hideMutation = useMutation({
    mutationFn: async ({ id, hidden }: { id: string; hidden: boolean }) => {
      await apiRequest('PATCH', `/api/truth-social-posts/${id}/hide`, { hidden });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/truth-social-posts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/truth-social-posts/all'] });
      queryClient.invalidateQueries({ queryKey: ['/api/stream-data'] });
    },
  });

  const removeImageMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest('PATCH', `/api/truth-social-posts/${id}/remove-image`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/truth-social-posts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/truth-social-posts/all'] });
      queryClient.invalidateQueries({ queryKey: ['/api/stream-data'] });
      toast({ title: 'Image hidden', description: 'The image has been hidden from this post.' });
    },
    onError: () => {
      toast({ title: 'Error', description: 'Failed to hide image.', variant: 'destructive' });
    },
  });

  const addManualMutation = useMutation({
    mutationFn: async (data: { content: string; postedAt: string; imageUrl?: string; linkUrl?: string }) => {
      const res = await apiRequest('POST', '/api/truth-social-posts/manual', data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/truth-social-posts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/truth-social-posts/all'] });
      queryClient.invalidateQueries({ queryKey: ['/api/stream-data'] });
      setContent('');
      setPostedAt('');
      setImageUrl('');
      setLinkUrl('');
      toast({ title: 'Post added', description: 'Manual Truth Social post has been added.' });
    },
    onError: () => {
      toast({ title: 'Error', description: 'Failed to add manual post.', variant: 'destructive' });
    },
  });

  const uploadImage = useCallback(async (file: File | Blob, fileName?: string) => {
    setUploading(true);
    try {
      if (file.size > 10 * 1024 * 1024) {
        throw new Error("File too large (max 10MB)");
      }
      let uploadBlob: Blob = file;
      let uploadName = fileName || (file instanceof File ? file.name : "pasted-image.jpg");
      if (file.size > 500 * 1024) {
        uploadBlob = await compressImage(file);
        uploadName = uploadName.replace(/\.[^.]+$/, ".jpg");
      }
      const formData = new FormData();
      formData.append("image", uploadBlob, uploadName);
      const res = await fetch("/api/stream/upload-image", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
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
      setImageUrl(data.url);
      toast({ title: "Image uploaded" });
    } catch (err: any) {
      const desc = err.name === "TypeError"
        ? "Network error - try a smaller image or check your connection."
        : err.message;
      toast({ title: "Upload failed", description: desc, variant: "destructive" });
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
        if (file) uploadImage(file, "pasted-image.png");
        return;
      }
    }
  }, [uploadImage]);

  const handleSubmitManual = () => {
    if (!content.trim() || !postedAt) {
      toast({ title: 'Missing fields', description: 'Content and time are required.', variant: 'destructive' });
      return;
    }
    addManualMutation.mutate({ content: content.trim(), postedAt, imageUrl: imageUrl.trim() || undefined, linkUrl: linkUrl.trim() || undefined });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          data-testid="button-manage-potus-posts"
        >
          <Send className="w-4 h-4 mr-2" />
          Manage POTUS Posts
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle data-testid="text-manage-potus-title">Manage POTUS Truth Social Posts</DialogTitle>
        </DialogHeader>

        <div className="flex gap-2 mb-3">
          <Button
            size="sm"
            variant={activeTab === 'manage' ? 'default' : 'outline'}
            onClick={() => setActiveTab('manage')}
            data-testid="button-tab-manage"
          >
            <EyeOff className="w-4 h-4 mr-1" />
            Remove Posts
          </Button>
          <Button
            size="sm"
            variant={activeTab === 'add' ? 'default' : 'outline'}
            onClick={() => setActiveTab('add')}
            data-testid="button-tab-add"
          >
            <Plus className="w-4 h-4 mr-1" />
            Add Manual Post
          </Button>
        </div>

        {activeTab === 'manage' && (
          <ScrollArea className="flex-1">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : allPosts.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No posts found.</p>
            ) : (
              <div className="space-y-2 pr-3">
                {allPosts.map((post) => (
                  <div
                    key={post.id}
                    className={`flex items-start gap-3 p-3 rounded-md border ${post.isHidden ? 'opacity-50 bg-muted/30' : ''}`}
                    data-testid={`manage-post-${post.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-[10px] text-muted-foreground font-mono" data-testid={`text-post-time-${post.id}`}>
                          {formatTime(post.postedAt)}
                        </span>
                        {post.isManual && (
                          <Badge variant="outline" className="text-[10px]">Manual</Badge>
                        )}
                        {post.isHidden && (
                          <Badge variant="secondary" className="text-[10px]">Hidden</Badge>
                        )}
                        {post.videoUrl && (
                          <Badge variant="outline" className="text-[10px]">Video</Badge>
                        )}
                      </div>
                      <p className="text-xs leading-relaxed line-clamp-2 whitespace-pre-wrap" data-testid={`text-post-content-${post.id}`}>
                        {cleanTruthContent(post.content)}
                      </p>
                      {post.imageUrl && (
                        <div className="flex items-center gap-2 mt-1.5">
                          <img
                            src={post.imageUrl}
                            alt="Post image"
                            className="w-12 h-12 object-cover rounded-md border"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                            data-testid={`img-post-thumb-${post.id}`}
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            onClick={() => removeImageMutation.mutate(post.id)}
                            disabled={removeImageMutation.isPending}
                            data-testid={`button-hide-image-${post.id}`}
                          >
                            <ImageOff className="w-3.5 h-3.5 mr-1" />
                            <span className="text-[11px]">Hide Image</span>
                          </Button>
                        </div>
                      )}
                    </div>
                    <Button
                      size="icon"
                      variant={post.isHidden ? 'default' : 'ghost'}
                      onClick={() => hideMutation.mutate({ id: post.id, hidden: !post.isHidden })}
                      disabled={hideMutation.isPending}
                      data-testid={`button-toggle-hide-${post.id}`}
                    >
                      {post.isHidden ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        )}

        {activeTab === 'add' && (
          <div className="space-y-4" onPaste={handlePaste}>
            <div>
              <Label htmlFor="manual-content">Post Content</Label>
              <Textarea
                id="manual-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Enter the text of the Truth Social post..."
                className="mt-1"
                rows={4}
                data-testid="input-manual-content"
              />
            </div>
            <div>
              <Label htmlFor="manual-time">Post Time (Eastern)</Label>
              <Input
                id="manual-time"
                type="datetime-local"
                value={postedAt}
                onChange={(e) => setPostedAt(e.target.value)}
                className="mt-1"
                data-testid="input-manual-time"
              />
              <p className="text-[10px] text-muted-foreground mt-1">Time will be interpreted as Eastern (ET)</p>
            </div>
            <div>
              <Label htmlFor="manual-image">Image (optional)</Label>
              <Input
                id="manual-image"
                type="url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="Paste image URL or use buttons below"
                className="mt-1"
                data-testid="input-manual-image"
              />
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleFileChange}
                  data-testid="input-manual-image-file"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  data-testid="button-manual-upload-image"
                >
                  {uploading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Upload className="w-4 h-4 mr-1" />}
                  {uploading ? "Uploading..." : "Upload Image"}
                </Button>
                <span className="text-[10px] text-muted-foreground">or paste an image from clipboard</span>
                {imageUrl && (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => setImageUrl('')}
                    data-testid="button-manual-clear-image"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                )}
              </div>
              {imageUrl && (
                <img
                  src={imageUrl}
                  alt="Preview"
                  className="mt-2 max-w-[200px] max-h-[120px] object-cover rounded-md border"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  data-testid="img-manual-preview"
                />
              )}
            </div>
            <div>
              <Label htmlFor="manual-link">Link URL (optional)</Label>
              <Input
                id="manual-link"
                type="url"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder="https://example.com/article"
                className="mt-1"
                data-testid="input-manual-link"
              />
              <p className="text-[10px] text-muted-foreground mt-1">Clicking the post will open this link</p>
            </div>
            <Button
              onClick={handleSubmitManual}
              disabled={addManualMutation.isPending || !content.trim() || !postedAt}
              data-testid="button-submit-manual-post"
            >
              {addManualMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Plus className="w-4 h-4 mr-2" />
              )}
              Add Post
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
