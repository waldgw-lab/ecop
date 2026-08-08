import { useState, useEffect, useCallback, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, ClipboardPaste, ExternalLink, Play } from "lucide-react";

export interface XPostReviewData {
  text: string;
  author: string;
  imageUrl: string | null;
  videoUrl: string | null;
  postedAt: string | null;
  url: string;
}

export interface XPostReviewSaveData {
  text: string;
  author: string;
  imageUrl: string | null;
  videoUrl: string | null;
  postedAt: string | null;
  url: string;
}

interface ReviewXPostDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  xPostData: XPostReviewData | null;
  onSave: (data: XPostReviewSaveData) => void;
  isSaving?: boolean;
}

export function ReviewXPostDialog({
  open,
  onOpenChange,
  xPostData,
  onSave,
  isSaving = false,
}: ReviewXPostDialogProps) {
  const [text, setText] = useState("");
  const [author, setAuthor] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [imageUploading, setImageUploading] = useState(false);

  const handleImagePaste = useCallback(async (e: ClipboardEvent) => {
    if (!open) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        setImageUploading(true);
        try {
          const formData = new FormData();
          formData.append('image', file, `xpost-${Date.now()}.png`);
          const resp = await fetch('/api/stream/upload-image', {
            method: 'POST',
            body: formData,
            credentials: 'include',
          });
          if (!resp.ok) throw new Error('Upload failed');
          const data = await resp.json();
          if (data.url) {
            setImageUrl(data.url);
          }
        } catch (err) {
          console.error('Failed to upload pasted image:', err);
        } finally {
          setImageUploading(false);
        }
        break;
      }
    }
  }, [open]);

  useEffect(() => {
    if (open) {
      document.addEventListener('paste', handleImagePaste);
      return () => document.removeEventListener('paste', handleImagePaste);
    }
  }, [open, handleImagePaste]);

  const prevOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && !wasOpen && xPostData) {
      setText(xPostData.text || "");
      setAuthor(xPostData.author || "");
      setImageUrl(xPostData.imageUrl || "");
    }
  }, [open, xPostData]);

  const hasVideo = !!xPostData?.videoUrl;

  const handleSave = () => {
    onSave({
      text: text.trim(),
      author: author.trim().replace(/^@/, ''),
      imageUrl: imageUrl.trim() || null,
      videoUrl: xPostData?.videoUrl || null,
      postedAt: xPostData?.postedAt || null,
      url: xPostData?.url || '',
    });
  };

  const displayAuthor = author.startsWith('@') ? author : `@${author}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl max-h-[90vh] flex flex-col"
        data-testid="dialog-review-x-post"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle data-testid="text-review-x-title">Review X Post</DialogTitle>
          <DialogDescription>Review the scraped X post before adding it to the feeds.</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-1">
          <div className="space-y-5 pb-2">

            <div className="space-y-1.5">
              <Label htmlFor="xpost-author" data-testid="label-x-author">Account Handle</Label>
              <Input
                id="xpost-author"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="@username"
                data-testid="input-x-author"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="xpost-text" data-testid="label-x-text">Post Text</Label>
              <Textarea
                id="xpost-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Post content..."
                className="min-h-[80px] resize-y"
                data-testid="input-x-text"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="xpost-image" data-testid="label-x-image">Image URL</Label>
              <Input
                id="xpost-image"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="https://pbs.twimg.com/..."
                data-testid="input-x-image"
              />
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <ClipboardPaste className="h-3 w-3" />
                Paste a screenshot anywhere in this dialog to upload it as the image
              </p>
              {imageUploading && (
                <div className="mt-2 rounded-md border p-4 flex flex-col items-center justify-center text-muted-foreground text-xs gap-1">
                  <Loader2 className="h-6 w-6 animate-spin" />
                  <span>Uploading pasted image...</span>
                </div>
              )}
              {!imageUploading && imageUrl.trim() && (
                <div className="mt-2 rounded-md border p-2 flex items-center justify-center" data-testid="xpost-image-preview">
                  <img
                    src={imageUrl}
                    alt="X post preview"
                    className="max-h-32 max-w-full object-contain rounded-md"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                </div>
              )}
            </div>

            <div className="space-y-3">
              <Label className="text-sm font-semibold">Previews</Label>

              <div className="rounded-md border p-3 space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Main Page (Text Only)</p>
                <div className="flex items-start gap-2">
                  <div className="flex-shrink-0 w-7 h-7 rounded-full bg-sky-600 flex items-center justify-center text-white text-xs font-bold">
                    {(author || 'X').charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold">{displayAuthor}</span>
                    </div>
                    <p className="text-sm mt-0.5 whitespace-pre-wrap break-words">{text || '(no text)'}</p>
                    {xPostData?.url && (
                      <a
                        href={xPostData.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-muted-foreground flex items-center gap-0.5 mt-1 hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        View on X
                      </a>
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-md border p-3 space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Stream Page (Text + {hasVideo ? 'Video' : 'Image'})
                </p>
                <div className="flex items-start gap-2">
                  <div className="flex-shrink-0 w-7 h-7 rounded-full bg-sky-600 flex items-center justify-center text-white text-xs font-bold">
                    {(author || 'X').charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold">{displayAuthor}</span>
                    </div>
                    <p className="text-sm mt-0.5 whitespace-pre-wrap break-words">{text || '(no text)'}</p>
                    {hasVideo && imageUrl.trim() ? (
                      <a
                        href={xPostData?.videoUrl || xPostData?.url || '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 block relative rounded-md overflow-hidden group"
                        data-testid="link-video-preview"
                      >
                        <img
                          src={imageUrl}
                          alt="Video thumbnail"
                          className="max-h-40 w-full object-cover rounded-md"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = "none";
                          }}
                        />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
                          <div className="w-10 h-10 rounded-full bg-white/90 flex items-center justify-center">
                            <Play className="h-5 w-5 text-black ml-0.5" />
                          </div>
                        </div>
                      </a>
                    ) : hasVideo ? (
                      <a
                        href={xPostData?.videoUrl || xPostData?.url || '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 block rounded-md border p-3 text-center text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
                        data-testid="link-video-watch"
                      >
                        <Play className="h-5 w-5 mx-auto mb-1" />
                        Video post - Watch on X
                        <br />
                        <span className="text-muted-foreground/70">Paste a screenshot to add a thumbnail</span>
                      </a>
                    ) : imageUrl.trim() ? (
                      <div className="mt-2 rounded-md overflow-hidden">
                        <img
                          src={imageUrl}
                          alt="X post media"
                          className="max-h-40 w-full object-cover rounded-md"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = "none";
                          }}
                        />
                      </div>
                    ) : (
                      <div className="mt-2 rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                        No image - paste a screenshot to add one
                      </div>
                    )}
                    {xPostData?.url && (
                      <a
                        href={xPostData.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-muted-foreground flex items-center gap-0.5 mt-1 hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        View on X
                      </a>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 pt-3 border-t">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
            data-testid="button-x-review-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={isSaving || !text.trim()}
            data-testid="button-x-review-save"
          >
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save & Submit"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
