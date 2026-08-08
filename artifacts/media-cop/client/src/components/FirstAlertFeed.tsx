import { Card } from "@/components/ui/card";
import { ExternalLink, AlertTriangle, MapPin } from "lucide-react";
import type { FirstAlert } from "@shared/schema";
import { formatCuratedPostTime, formatShareDateTime } from "@/lib/postTime";
import { useTimezone } from "@/lib/timezone";
import CopyShareButton from "@/components/CopyShareButton";
import { escapeHtml } from "@/lib/richCopy";

interface FirstAlertFeedProps {
  alerts: FirstAlert[];
  // "curated" leads each item with the alert's location + a severity badge and
  // strips the source attribution from the body. Any other view ("default")
  // keeps the original "DataMinr First Alert" label and full headline.
  variant?: "default" | "curated";
  // The curated variant scrolls itself (max-h) by default. Set scroll={false}
  // when an ancestor already provides the scroll container (e.g. the R1 social
  // bloc column wrapper) so the feed doesn't nest a scroll inside a scroll.
  scroll?: boolean;
}

// DataMinr's alertType conveys severity. Only Flash and Urgent are notable
// enough to surface; everything else (e.g. standard "Alert") maps to "outline",
// which callers treat as "don't show a severity label".
function severityVariant(alertType: string | null): "destructive" | "default" | "outline" {
  const t = (alertType || "").toLowerCase();
  if (t === "flash") return "destructive";
  if (t === "urgent") return "default";
  return "outline";
}

// DataMinr headlines embed the alert's source as an attribution suffix after the
// last colon, e.g. "Air raid sirens activated in Kryvyi Rih, Ukraine: Local
// Source via Public Telegram Board." Split that off so we can show the source on
// its own line (instead of a constant "DataMinr First Alert" label) and keep the
// body to just the event description. Falls back to no source when the headline
// doesn't follow the pattern.
function splitHeadlineSource(headline: string): { source: string | null; text: string } {
  const idx = headline.lastIndexOf(": ");
  if (idx === -1) return { source: null, text: headline };
  const source = headline.slice(idx + 2).replace(/\.\s*$/, "").trim();
  const text = headline.slice(0, idx).trim();
  if (!source || !text || source.length > 70) return { source: null, text: headline };
  return { source, text };
}

// DataMinr locations are often verbose, e.g. "Zaporizhzhia, Zaporizhia Oblast,
// Ukraine, 69061" or "Canberra, ACT, Australia". Condense to "city or state,
// Country" by keeping the first segment (the most specific place) plus the
// country, dropping the middle administrative region and any trailing postal
// code. Two-or-fewer-segment locations are already concise and pass through.
function condenseLocation(location: string | null): string {
  if (!location) return "";
  const parts = location.split(",").map((p) => p.trim()).filter(Boolean);
  // Drop trailing postal-code-like segments (purely numeric, e.g. "69061").
  while (parts.length > 1 && /^\d[\d\s-]*$/.test(parts[parts.length - 1])) {
    parts.pop();
  }
  if (parts.length <= 2) return parts.join(", ");
  return `${parts[0]}, ${parts[parts.length - 1]}`;
}

// Build the rich-copy HTML payload for a curated DataMinr First Alert: bold +
// hyperlinked source/location attribution line, an absolute date-time, and the
// cleaned alert body text.
function buildAlertCopyHtml(alert: FirstAlert, tz: string): string {
  const { source, text } = splitHeadlineSource(alert.headline);
  let attribution =
    condenseLocation(alert.location) || source || "DATAMINR";
  if (alert.alertType && severityVariant(alert.alertType) !== "outline") {
    attribution += ` · ${alert.alertType}`;
  }
  const lines: string[] = [];
  lines.push(
    `<div><b><a href="${escapeHtml(alert.url)}">${escapeHtml(attribution)}</a></b></div>`,
  );
  const when = formatShareDateTime(alert.publishedAt, tz);
  if (when) lines.push(`<div>${escapeHtml(when)}</div>`);
  if (text) lines.push(`<div>${escapeHtml(text).replace(/\n/g, "<br>")}</div>`);
  return lines.join("");
}

function formatTimestamp(date: Date): string {
  const alertDate = new Date(date);
  const now = new Date();
  
  const isToday = alertDate.getDate() === now.getDate() &&
                  alertDate.getMonth() === now.getMonth() &&
                  alertDate.getFullYear() === now.getFullYear();
  
  if (isToday) {
    return alertDate.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    });
  }
  
  const diffMs = now.getTime() - alertDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays < 7) {
    return alertDate.toLocaleString('en-US', { 
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }
  
  return alertDate.toLocaleString('en-US', { 
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

export default function FirstAlertFeed({ alerts, variant = "default", scroll = true }: FirstAlertFeedProps) {
  const isCurated = variant === "curated";
  const tz = useTimezone();
  if (alerts.length === 0) {
    return (
      <Card className="p-4">
        <div className="text-center text-sm text-muted-foreground">
          No First Alert notifications available yet
        </div>
      </Card>
    );
  }

  return (
    <div
      className={
        isCurated && scroll
          ? "curated-scroll overflow-y-auto overflow-x-hidden max-h-[640px] pr-2 space-y-2"
          : "space-y-2"
      }
    >
      {alerts.map((alert) => {
        const { source, text } = splitHeadlineSource(alert.headline);
        return (
        <Card 
          key={alert.id} 
          className={`p-3 hover-elevate active-elevate-2 cursor-pointer${isCurated ? " shadow-md shadow-black/30 curated-feed-card" : ""}`}
          onClick={() => window.open(alert.url, '_blank')}
          data-testid={`card-first-alert-${alert.id}`}
        >
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                {!isCurated && (
                  <div className="w-8 h-8 rounded-full bg-destructive/10 flex items-center justify-center flex-shrink-0">
                    <AlertTriangle className="h-4 w-4 text-destructive" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  {isCurated ? (
                    <div className="flex items-center min-w-0" data-testid="text-source">
                      <MapPin className="h-3 w-3 flex-shrink-0 text-[#5FA8C4]" />
                      <span className="ml-1 text-xs font-semibold text-[#5FA8C4] truncate">
                        {condenseLocation(alert.location) || source || 'DATAMINR'}
                        {alert.alertType && severityVariant(alert.alertType) !== "outline" && ` · ${alert.alertType}`}
                      </span>
                    </div>
                  ) : (
                    <div className="text-xs font-semibold text-destructive" data-testid="text-source">
                      DATAMINR{alert.alertType === 'Flash' && ' *Flash*'}
                    </div>
                  )}
                  <div className={`text-xs text-muted-foreground${isCurated ? "" : " font-mono"}`} data-testid="text-timestamp">
                    {isCurated
                      ? formatCuratedPostTime(alert.publishedAt, tz)
                      : formatTimestamp(alert.publishedAt)}
                  </div>
                </div>
              </div>
              {isCurated ? (
                <div className="flex items-center gap-0.5 flex-shrink-0">
                  <CopyShareButton
                    testId={`button-copy-first-alert-${alert.id}`}
                    label="Copy alert to clipboard"
                    buildHtml={() => buildAlertCopyHtml(alert, tz)}
                  />
                </div>
              ) : (
                <ExternalLink className="h-3 w-3 text-muted-foreground flex-shrink-0" />
              )}
            </div>
            
            <p className="text-xs leading-relaxed font-medium" data-testid="text-headline">
              {isCurated ? text : alert.headline}
            </p>
          </div>
        </Card>
        );
      })}
    </div>
  );
}
