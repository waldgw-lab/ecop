import { formatCuratedPublicationDTG } from "@/lib/postTime";

export type NewsCandidateTimeContext = {
  source: string;
  sourceCount?: number | null;
  articlePublishedAt?: string | Date | null;
  firstSeenAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

export function formatCandidateRelativeAge(
  date: string | Date | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (!date) return "";
  const valueMs = new Date(date).getTime();
  if (!Number.isFinite(valueMs)) return "";
  const diffMs = nowMs - valueMs;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatNewsCandidateContext(
  candidate: NewsCandidateTimeContext,
  tz: string,
  nowMs: number = Date.now(),
): string {
  if ((candidate.sourceCount ?? 0) > 1) {
    const count = `${candidate.sourceCount} sources`;
    const age = formatCandidateRelativeAge(candidate.updatedAt, nowMs);
    return age ? `${count} · Updated ${age}` : count;
  }

  const published = candidate.articlePublishedAt
    ? formatCuratedPublicationDTG(candidate.articlePublishedAt, tz)
    : "";
  if (published) return `${candidate.source} · Published ${published}`;

  const firstSeen = candidate.firstSeenAt
    ? formatCuratedPublicationDTG(candidate.firstSeenAt, tz)
    : "";
  return firstSeen ? `${candidate.source} · First seen ${firstSeen}` : candidate.source;
}

export function isCandidateHeadlineTruncated(
  scrollWidth: number,
  clientWidth: number,
): boolean {
  return clientWidth > 0 && scrollWidth > clientWidth;
}