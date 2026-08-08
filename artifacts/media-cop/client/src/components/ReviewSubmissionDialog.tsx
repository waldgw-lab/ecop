import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { PRIMARY_TOPICS, OTHER_EMERGING, CONFLICT_TRACKS } from "@shared/classificationVocab";
import { Switch } from "@/components/ui/switch";
import { Loader2, ImageIcon, ClipboardPaste, Sparkles, AlertTriangle } from "lucide-react";

export interface ReviewData {
  headline: string;
  headlineGenerated?: boolean;
  headlineSource?: 'scraped' | 'pasted' | 'generated';
  summary: string;
  ogImageUrl: string | null;
  summaryBullets: string[];
  articleText: string;
  priorityScore: number;
  tags: string[];
  suggestedTopic: string;
  // Curated classification ENRICHMENT suggestions (Task #336). The AI's proposed
  // controlled-vocabulary object; the reviewer may accept (leave "Auto") or
  // override any of these from the approved list. All optional/nullable — absent
  // means "let the server classify on admission".
  suggestedPrimaryTopic?: string | null;
  suggestedConflictTrack?: string | null;
  suggestedRegion?: string | null;
  suggestedCountry?: string | null;
  suggestedCountryPair?: string[] | null;
  sourceName: string;
  sourceType: string;
  publishedAt: string | null;
  existingTopics: string[];
  // Set when auto-fill couldn't read the link (slow / paywalled / blocked). The
  // dialog stays open and usable; this just shows a note so the reviewer knows
  // to fill in the details and post manually. The link is never dropped.
  metadataError?: string | null;
  // Progressive-reveal markers (interactive review streaming). When present, the
  // marked fields are still arriving and the dialog shows a loading cue for them.
  // `metadata` covers headline/source/image (streamed AFTER the dialog opens).
  // Absent for non-streaming payloads.
  _loading?: { metadata?: boolean; priority: boolean; bullets: boolean; classification?: boolean };
}

export interface ReviewSaveData {
  headline: string;
  ogImageUrl: string | null;
  summaryBullets: string[];
  articleText: string;
  priorityScore: number;
  topicId: string | null;
  newTopicName: string | null;
  mcopEnabled: boolean;
  sourceType: string;
  sourceName: string;
  // Curated classification ENRICHMENT override (Task #336). null = no human
  // override → the server's gate-mode AI classifies on admission. A non-null
  // value is the reviewer's pick from the approved list and FOLLOWS the item
  // into the Curated lane (curated-only; never affects Main/Visual).
  primaryTopic: string | null;
  conflictTrack: string | null;
  region: string | null;
  country: string | null;
  countryPair: string[] | null;
  // The AI-suggested regional Subject (teamSubjects) name. The reviewer no
  // longer hand-picks the regional folder — it is auto-assigned server-side
  // from this value, so Team-page topic cards + the public API keep working.
  autoSubjectName: string | null;
}

interface ReviewSubmissionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reviewData: ReviewData | null;
  existingTopics: Array<{ id: string; name: string }>;
  onSave: (data: ReviewSaveData) => void;
  isSaving?: boolean;
}

export function ReviewSubmissionDialog({
  open,
  onOpenChange,
  reviewData,
  existingTopics,
  onSave,
  isSaving = false,
}: ReviewSubmissionDialogProps) {
  const [headline, setHeadline] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [bullets, setBullets] = useState<string[]>(["", "", ""]);
  const [priority, setPriority] = useState(50);
  const [mcopEnabled, setMcopEnabled] = useState(true);
  // Curated classification override (Task #336). "__auto__" = no override.
  const [primaryTopic, setPrimaryTopic] = useState<string>("__auto__");
  const [conflictTrack, setConflictTrack] = useState<string>("__auto__");
  const [classRegion, setClassRegion] = useState("");
  const [classCountry, setClassCountry] = useState("");
  const [imageUploading, setImageUploading] = useState(false);
  const [articleText, setArticleText] = useState("");
  const [generatingBullets, setGeneratingBullets] = useState(false);
  const pasteZoneRef = useRef<HTMLDivElement>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastGeneratedTextRef = useRef<string>("");
  const prevOpenRef = useRef(false);
  const headlineRef = useRef("");
  // Track which fields the user has manually edited so progressive streaming
  // updates (headline/image/priority/bullets arriving after the dialog opens)
  // never clobber a human edit.
  const headlineTouchedRef = useRef(false);
  const imageTouchedRef = useRef(false);
  const priorityTouchedRef = useRef(false);
  const bulletsTouchedRef = useRef(false);
  const articleTextTouchedRef = useRef(false);
  const classTouchedRef = useRef(false);

  const metadataLoading = !!reviewData?._loading?.metadata;
  const metadataError = reviewData?.metadataError || null;
  const priorityLoading = !!reviewData?._loading?.priority;
  const bulletsLoading = !!reviewData?._loading?.bullets;
  const classificationLoading = !!reviewData?._loading?.classification;

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
          formData.append('image', file, `paste-${Date.now()}.png`);
          const resp = await fetch('/api/stream/upload-image', {
            method: 'POST',
            body: formData,
            credentials: 'include',
          });
          if (!resp.ok) throw new Error('Upload failed');
          const data = await resp.json();
          if (data.url) {
            imageTouchedRef.current = true; // user-supplied image — don't let auto-fill overwrite
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

  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && !wasOpen && reviewData) {
      const initialHeadline = reviewData.headline || "";
      setHeadline(initialHeadline);
      headlineRef.current = initialHeadline;
      setImageUrl(reviewData.ogImageUrl || "");
      const b = [...(reviewData.summaryBullets || [])];
      while (b.length < 3) b.push("");
      setBullets(b.slice(0, 3));
      setPriority(reviewData.priorityScore || 50);
      setMcopEnabled(true);
      // Curated classification: default the selects to the AI suggestion when it
      // matches the approved list (the reviewer can override); otherwise "Auto"
      // (no override → the server gate-mode AI classifies on admission).
      const sPt = (reviewData.suggestedPrimaryTopic || "").trim();
      setPrimaryTopic(
        sPt && ((PRIMARY_TOPICS as readonly string[]).includes(sPt) || sPt === OTHER_EMERGING)
          ? sPt
          : "__auto__",
      );
      const sCt = (reviewData.suggestedConflictTrack || "").trim();
      setConflictTrack(
        sCt && (CONFLICT_TRACKS as readonly string[]).includes(sCt) ? sCt : "__auto__",
      );
      setClassRegion((reviewData.suggestedRegion || "").trim());
      setClassCountry((reviewData.suggestedCountry || "").trim());
      setArticleText(reviewData.articleText || "");
      lastGeneratedTextRef.current = "";
      // Fresh review — no user edits yet.
      headlineTouchedRef.current = false;
      imageTouchedRef.current = false;
      priorityTouchedRef.current = false;
      bulletsTouchedRef.current = false;
      articleTextTouchedRef.current = false;
      classTouchedRef.current = false;
    }
  }, [open, reviewData, existingTopics]);

  // Progressive reveal: the headline / image / source now stream in AFTER the
  // dialog opens (stream-first review). Apply them once the metadata frame
  // arrives, unless the reviewer already typed/pasted their own — so a slow or
  // paywalled link never blocks the dialog and never clobbers a manual edit.
  useEffect(() => {
    if (!open || !reviewData) return;
    if (reviewData._loading?.metadata) return;
    if (!headlineTouchedRef.current && reviewData.headline) {
      setHeadline(reviewData.headline);
      headlineRef.current = reviewData.headline;
    }
    if (!imageTouchedRef.current && reviewData.ogImageUrl) {
      setImageUrl(reviewData.ogImageUrl);
    }
  }, [open, reviewData?._loading?.metadata, reviewData?.headline, reviewData?.ogImageUrl]);

  useEffect(() => {
    headlineRef.current = headline;
  }, [headline]);

  const generateBulletsFromText = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length < 50) return;
    if (trimmed === lastGeneratedTextRef.current) return;
    lastGeneratedTextRef.current = trimmed;
    setGeneratingBullets(true);
    try {
      const resp = await fetch('/api/stream/summarize-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed, headline: headlineRef.current.trim() }),
        credentials: 'include',
      });
      if (!resp.ok) throw new Error('Failed to generate bullets');
      const data = await resp.json();
      if (data.bullets && Array.isArray(data.bullets)) {
        const newBullets = [...data.bullets];
        while (newBullets.length < 3) newBullets.push("");
        setBullets(newBullets.slice(0, 3));
      }
    } catch (err) {
      console.error('Failed to generate bullets:', err);
    } finally {
      setGeneratingBullets(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    if (articleText.trim().length < 50) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      generateBulletsFromText(articleText);
    }, 800);
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [articleText, open, generateBulletsFromText]);

  // Progressive reveal: apply the priority score once it streams in, unless the
  // user already edited it. The server streams priority in two phases — a fast
  // headline-based value first, then a refined body-aware value — so this effect
  // keys on `priorityScore` and quietly UPGRADES the displayed score when the
  // refined value arrives, still respecting the per-field "touched" guard.
  useEffect(() => {
    if (!open || !reviewData) return;
    if (reviewData._loading?.priority) return;
    if (priorityTouchedRef.current) return;
    setPriority(reviewData.priorityScore || 50);
  }, [open, reviewData?.priorityScore, reviewData?._loading?.priority]);

  // Progressive reveal: apply the summary bullets + article text once they
  // stream in. Setting articleText also drives the existing auto-generate
  // debounce (matching today's behavior). User edits are preserved.
  useEffect(() => {
    if (!open || !reviewData) return;
    if (reviewData._loading?.bullets) return;
    if (!articleTextTouchedRef.current && reviewData.articleText) {
      setArticleText(reviewData.articleText);
    }
    if (!bulletsTouchedRef.current) {
      const b = [...(reviewData.summaryBullets || [])];
      while (b.length < 3) b.push("");
      setBullets(b.slice(0, 3));
    }
  }, [
    open,
    reviewData?._loading?.bullets,
    reviewData?.articleText,
    reviewData?.summaryBullets,
  ]);

  // Progressive reveal: apply the AI classification suggestion once it streams
  // in (it arrives after the dialog opens on the meta frame), unless the
  // reviewer already picked an override. Mirrors the priority/bullets pattern;
  // only fills selects when the suggestion matches the approved vocabulary.
  useEffect(() => {
    if (!open || !reviewData) return;
    if (reviewData._loading?.classification) return;
    if (classTouchedRef.current) return;
    const sPt = (reviewData.suggestedPrimaryTopic || "").trim();
    if (sPt && ((PRIMARY_TOPICS as readonly string[]).includes(sPt) || sPt === OTHER_EMERGING)) {
      setPrimaryTopic(sPt);
    }
    const sCt = (reviewData.suggestedConflictTrack || "").trim();
    if (sCt && (CONFLICT_TRACKS as readonly string[]).includes(sCt)) {
      setConflictTrack(sCt);
    }
    const sRegion = (reviewData.suggestedRegion || "").trim();
    if (sRegion) setClassRegion(sRegion);
    const sCountry = (reviewData.suggestedCountry || "").trim();
    if (sCountry) setClassCountry(sCountry);
  }, [
    open,
    reviewData?._loading?.classification,
    reviewData?.suggestedPrimaryTopic,
    reviewData?.suggestedConflictTrack,
    reviewData?.suggestedRegion,
    reviewData?.suggestedCountry,
  ]);

  const handleBulletChange = (index: number, value: string) => {
    bulletsTouchedRef.current = true;
    const words = value.split(/\s+/).filter(w => w.length > 0);
    const truncated = words.length > 15 ? words.slice(0, 15).join(' ') : value;
    const updated = [...bullets];
    updated[index] = truncated;
    setBullets(updated);
  };

  const handleSave = () => {
    const filteredBullets = bullets.filter((b) => b.trim().length > 0);
    onSave({
      headline: headline.trim(),
      ogImageUrl: imageUrl.trim() || null,
      summaryBullets: filteredBullets,
      articleText: articleText.trim(),
      priorityScore: Math.min(100, Math.max(1, priority)),
      // The regional Subject is now AI-auto-assigned server-side (see
      // autoSubjectName); the reviewer no longer hand-picks it here. A reviewer
      // may still optionally override the folder from the compose bar, which the
      // page merges in at the top level.
      topicId: null,
      newTopicName: null,
      mcopEnabled,
      sourceType: reviewData?.sourceType || 'news',
      sourceName: reviewData?.sourceName || 'News Source',
      // The 20-category PRIMARY TOPIC is the reviewer's required main pick.
      primaryTopic: primaryTopic !== "__auto__" ? primaryTopic : null,
      // The "second identifier" (conflict track + geography + focus pair) is
      // fully AI-derived; carry the review-time suggestions so they FOLLOW the
      // item into the curated overlay (the generate-once lock would otherwise
      // leave them blank once the human bucket is set).
      conflictTrack: conflictTrack !== "__auto__" ? conflictTrack : null,
      region: classRegion.trim() || null,
      country: classCountry.trim() || null,
      countryPair:
        Array.isArray(reviewData?.suggestedCountryPair) && reviewData!.suggestedCountryPair!.length
          ? reviewData!.suggestedCountryPair!
          : null,
      autoSubjectName: (reviewData?.suggestedTopic || "").trim() || null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl max-h-[90vh] flex flex-col"
        data-testid="dialog-review-submission"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle data-testid="text-review-title">Review Submission</DialogTitle>
          <DialogDescription>Review and edit the AI-generated analysis before submitting.</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-1">
          <div className="space-y-5 pb-2">
            <div className="space-y-1.5">
              <Label htmlFor="review-headline" data-testid="label-headline">Headline</Label>
              <Input
                id="review-headline"
                value={headline}
                onChange={(e) => {
                  headlineTouchedRef.current = true;
                  setHeadline(e.target.value);
                }}
                placeholder="Enter headline..."
                data-testid="input-headline"
              />
              {metadataLoading && !headlineTouchedRef.current && (
                <p
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  data-testid="text-metadata-loading"
                >
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  Reading the link…
                </p>
              )}
              {!metadataLoading && metadataError && (
                <p
                  className="flex items-start gap-1.5 text-xs text-muted-foreground"
                  data-testid="text-metadata-error"
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive mt-0.5" />
                  <span>{metadataError}</span>
                </p>
              )}
              {!metadataLoading && !metadataError && reviewData?.headlineGenerated && (
                <p
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  data-testid="text-headline-generated"
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                  Headline not found — generated
                </p>
              )}
            </div>

            <div className="space-y-1.5" ref={pasteZoneRef}>
              <Label htmlFor="review-image" data-testid="label-image">Stream Page Image</Label>
              <Input
                id="review-image"
                value={imageUrl}
                onChange={(e) => {
                  imageTouchedRef.current = true;
                  setImageUrl(e.target.value);
                }}
                placeholder="https://example.com/image.jpg"
                data-testid="input-image-url"
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
                <div className="mt-2 rounded-md border p-2 flex items-center justify-center" data-testid="image-preview">
                  <img
                    src={imageUrl}
                    alt="Preview"
                    className="max-h-32 max-w-full object-contain rounded-md"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                </div>
              )}
              {!imageUploading && !imageUrl.trim() && (
                <div className="mt-2 rounded-md border border-dashed p-4 flex flex-col items-center justify-center text-muted-foreground text-xs gap-1">
                  <ImageIcon className="h-6 w-6" />
                  <span>No image — paste a screenshot or enter a URL above</span>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <Label data-testid="label-bullets">Stream Page Bullets</Label>
                {bulletsLoading && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="status-bullets-loading">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Summarizing…
                  </span>
                )}
              </div>
              <div className="space-y-2">
                {bullets.map((bullet, index) => (
                  <div key={index}>
                    <Input
                      value={bullet}
                      onChange={(e) => handleBulletChange(index, e.target.value)}
                      placeholder={index === 0 ? "What changed / the big announcement..." : index === 1 ? "Background context..." : "Supplemental information..."}
                      data-testid={`input-bullet-${index}`}
                    />
                    <p className={`text-xs mt-0.5 ${bullet.split(/\s+/).filter(w => w.length > 0).length >= 15 ? 'text-destructive' : 'text-muted-foreground'}`} data-testid={`text-bullet-count-${index}`}>
                      {bullet.split(/\s+/).filter(w => w.length > 0).length}/15 words
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label data-testid="label-article-text">Generate Bullets from Article Text</Label>
              <Textarea
                value={articleText}
                onChange={(e) => { articleTextTouchedRef.current = true; setArticleText(e.target.value); }}
                placeholder="Paste the article text here to auto-generate bullet summaries..."
                className="resize-none text-sm"
                rows={4}
                data-testid="textarea-article-text"
              />
              <div className="flex items-center justify-between gap-2 flex-wrap">
                {generatingBullets ? (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Generating bullet summaries...
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Bullets auto-generate when you paste article text (max 15 words each)
                  </p>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { lastGeneratedTextRef.current = ""; generateBulletsFromText(articleText); }}
                  disabled={generatingBullets || articleText.trim().length < 50}
                  data-testid="button-generate-bullets"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Regenerate
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <Label htmlFor="review-priority" data-testid="label-priority">Priority Score (1-100)</Label>
                {priorityLoading && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="status-priority-loading">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Scoring…
                  </span>
                )}
              </div>
              <Input
                id="review-priority"
                type="number"
                min={1}
                max={100}
                value={priority}
                onChange={(e) => { priorityTouchedRef.current = true; setPriority(parseInt(e.target.value) || 1); }}
                data-testid="input-priority"
              />
              <p className="text-xs text-muted-foreground">
                Stories with priority 66+ are auto-promoted to MCOP dashboard
              </p>
            </div>

            {/* Primary Topic is the reviewer's MAIN, required pick from the
                controlled 20-category vocabulary (Task #336). It FOLLOWS the
                item into the Curated lane (curated-only — never touches
                Main/Visual/custom-MCOP/public API). The regional Subject folder
                and all geography/conflict metadata below are AI-derived. */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <Label htmlFor="review-primary-topic" data-testid="label-topic">Topic</Label>
                {classificationLoading && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="status-classification-loading">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Classifying…
                  </span>
                )}
              </div>
              <Select value={primaryTopic} onValueChange={(v) => { classTouchedRef.current = true; setPrimaryTopic(v); }}>
                <SelectTrigger id="review-primary-topic" data-testid="select-primary-topic">
                  <SelectValue placeholder="Select a topic…" />
                </SelectTrigger>
                <SelectContent>
                  {/* Sorted A→Z for scannability (local copy — the canonical
                      PRIMARY_TOPICS order elsewhere is untouched). The
                      "Other / Emerging" catch-all stays pinned at the bottom. */}
                  {[...PRIMARY_TOPICS].sort((a, b) => a.localeCompare(b)).map((t) => (
                    <SelectItem key={t} value={t} data-testid={`select-primary-topic-${t}`}>{t}</SelectItem>
                  ))}
                  <SelectItem value={OTHER_EMERGING} data-testid="select-primary-topic-other">{OTHER_EMERGING}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Pick the main subject. The folder, region, country, and focus are set automatically by AI.
              </p>
            </div>

            {/* AI-derived "second identifier" — shown read-only. The reviewer
                picks the Topic above; everything here is auto-assigned and
                follows the item into the Curated lane. */}
            <div className="space-y-2 rounded-md border p-3">
              <Label data-testid="label-classification">AI-derived details</Label>
              {classificationLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="status-ai-details-loading">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Working out the folder, region, country, and focus…
                </div>
              ) : (
                <div className="flex flex-wrap gap-2" data-testid="group-ai-details">
                  <Badge variant="secondary" data-testid="badge-auto-subject">
                    Folder: {reviewData?.suggestedTopic?.trim() || "General"}
                  </Badge>
                  {classRegion.trim() && (
                    <Badge variant="outline" data-testid="badge-class-region">{classRegion.trim()}</Badge>
                  )}
                  {classCountry.trim() && (
                    <Badge variant="outline" data-testid="badge-class-country">{classCountry.trim()}</Badge>
                  )}
                  {Array.isArray(reviewData?.suggestedCountryPair) && reviewData!.suggestedCountryPair!.length > 0 && (
                    <Badge variant="outline" data-testid="badge-class-country-pair">
                      {reviewData!.suggestedCountryPair!.join(" – ")}
                    </Badge>
                  )}
                  {conflictTrack !== "__auto__" && (
                    <Badge variant="outline" data-testid="badge-conflict-track">{conflictTrack}</Badge>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="review-mcop" data-testid="label-mcop">Push to MCOP Dashboard</Label>
                <p className="text-xs text-muted-foreground">
                  Include this story on the main MCOP stream page
                </p>
              </div>
              <Switch
                id="review-mcop"
                checked={mcopEnabled}
                onCheckedChange={setMcopEnabled}
                data-testid="switch-mcop"
              />
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
            data-testid="button-review-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!headline.trim() || bullets.filter(b => b.trim()).length === 0 || primaryTopic === "__auto__" || isSaving || imageUploading || generatingBullets}
            data-testid="button-review-save"
          >
            {isSaving ? (
              <>
                <Loader2 className="animate-spin" />
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