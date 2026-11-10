import type { FinanceStory } from "@shared/finance";
import { ExternalLink, X } from "lucide-react";
import { KIND_LABEL, fmtDateTime, impactTone } from "./utils";

export function StoryDetail({ story, onClose }: { story: FinanceStory | null; onClose?: () => void }) {
  if (!story) {
    return (
      <div className="p-6 text-sm text-[hsl(var(--fsw-dim))]" data-testid="text-detail-empty">
        <p className="fsw-label mb-2">Item detail</p>
        Select a story or signal to see its evidence breakdown, attribution and related sources.
      </div>
    );
  }
  const total = story.evidence.reduce((a, e) => a + e.points, 0);
  const max = story.evidence.reduce((a, e) => a + e.maximum, 0);
  return (
    <article className="p-5 fsw-in" key={story.id} data-testid={`detail-story-${story.id}`}>
      <div className="flex items-start justify-between gap-3">
        <p className={`fsw-label fsw-k-${story.kind}`}>{KIND_LABEL[story.kind]} · {story.confidence}</p>
        {onClose && (
          <button onClick={onClose} aria-label="Close detail" className="text-[hsl(var(--fsw-dim))] hover:text-[hsl(var(--fsw-ink))]" data-testid="button-close-detail">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <h2 className="mt-2 text-xl font-semibold leading-snug">{story.title}</h2>
      {story.summary ? (
        <p className="mt-3 text-sm leading-relaxed text-[hsl(var(--fsw-ink)/0.85)]">{story.summary}</p>
      ) : (
        <p className="mt-3 text-sm italic text-[hsl(var(--fsw-dim))]">No description supplied by the feed.</p>
      )}
      <p className="mt-2 text-[11px] text-[hsl(var(--fsw-dim))]">Text shown is the feed-supplied description only. Open the source for the full item.</p>
      <a href={story.url} target="_blank" rel="noreferrer noopener" className="mt-3 inline-flex items-center gap-1.5 text-sm text-[hsl(var(--fsw-brass))] hover:underline" data-testid="link-story-source">
        Open at {story.source} <ExternalLink className="h-3.5 w-3.5" />
      </a>

      <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2 text-xs fsw-mono">
        <dt className="text-[hsl(var(--fsw-dim))]">Source</dt><dd>{story.source}</dd>
        <dt className="text-[hsl(var(--fsw-dim))]">Owner</dt><dd>{story.owner || "—"}</dd>
        <dt className="text-[hsl(var(--fsw-dim))]">Published</dt><dd>{fmtDateTime(story.publishedAt)}</dd>
        <dt className="text-[hsl(var(--fsw-dim))]">Fetched</dt><dd>{fmtDateTime(story.observedAt)}</dd>
        <dt className="text-[hsl(var(--fsw-dim))]">Topic</dt><dd>{story.topic}</dd>
        <dt className="text-[hsl(var(--fsw-dim))]">Region</dt><dd>{story.region}</dd>
        {story.alertType && (<><dt className="text-[hsl(var(--fsw-dim))]">Alert type</dt><dd>{story.alertType}</dd></>)}
        {story.terms && (<><dt className="text-[hsl(var(--fsw-dim))]">Provider usage terms</dt><dd className="break-words">{story.terms}</dd></>)}
      </dl>

      <section className="mt-6">
        <div className="flex items-baseline justify-between">
          <p className="fsw-label">Rule-based evidence score</p>
          <p className="fsw-mono text-sm" style={{ color: impactTone(story.impact) }} data-testid="text-detail-impact">{story.impact}<span className="text-[hsl(var(--fsw-dim))]"> / 100</span></p>
        </div>
        <ul className="mt-3 space-y-2">
          {story.evidence.map((e) => {
            const pct = e.maximum > 0 ? Math.max(0, Math.min(1, e.points / e.maximum)) : 0;
            return (
              <li key={e.label} className="text-xs">
                <div className="flex justify-between"><span>{e.label}</span><span className="fsw-mono text-[hsl(var(--fsw-dim))]">{e.points} / {e.maximum}</span></div>
                <div className="mt-1 h-1.5 bg-[hsl(var(--fsw-line))] overflow-hidden rounded-sm">
                  <div className="h-full origin-left bg-[hsl(var(--fsw-brass))] transition-transform duration-500" style={{ transform: `scaleX(${pct})` }} />
                </div>
              </li>
            );
          })}
        </ul>
        {story.evidence.length > 0 && <p className="mt-2 fsw-mono text-[11px] text-[hsl(var(--fsw-dim))]">Components sum {total} of {max} possible.</p>}
      </section>

      {story.reasons.length > 0 && (
        <section className="mt-5">
          <p className="fsw-label">Why it ranked</p>
          <ul className="mt-2 list-disc pl-4 space-y-1 text-sm">{story.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </section>
      )}

      <section className="mt-5">
        <p className="fsw-label">Related coverage ({story.sourceCount} publishers)</p>
        {story.relatedSources.length === 0 ? (
          <p className="mt-2 text-sm text-[hsl(var(--fsw-dim))]">Single-source item. No matching coverage grouped in this cycle. Grouping never establishes independent confirmation.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {story.relatedSources.map((r, i) => (
              <li key={i}><a href={r.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-sm hover:text-[hsl(var(--fsw-brass))]" data-testid={`link-related-${i}`}>{r.source}<ExternalLink className="h-3 w-3 opacity-60" /></a></li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
