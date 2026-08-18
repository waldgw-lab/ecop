// =============================================================================
// Dominant-angle fallback headline for un-synthesized formed stories (Task #1141)
// -----------------------------------------------------------------------------
// A formed multi-source curated story can be displayed with NO synthesis row
// (synthesis deferred by the pass deadline, or a transient LLM failure). The
// read path then falls back to the representative member's own title — and
// because the rep is often the NEWEST member, the card can present a single
// outlet's narrow/editorial reaction angle ("Senator says he's not comfortable
// with X deal") as if it were the cluster's neutral headline, instead of the
// dominant development the majority of sources report (the deal itself).
//
// This pure, deterministic helper picks the corroborating member whose title
// best OVERLAPS the other corroborating members' titles (cheap token overlap —
// no AI call). The member reporting the shared underlying event scores high
// (its vocabulary is echoed by everyone), while a one-owner reaction angle
// scores low (its distinctive vocabulary appears nowhere else).
//
// Fail-open contract: return null whenever the heuristic cannot pick a CLEAR
// winner (fewer than 2 scorable corroborating members, or no meaningful
// overlap anywhere) — the caller then keeps the existing rep fallback.
// Display-only: the caller only swaps the DISPLAYED title/bullets; the story's
// matching/search `title`, rep identity, media, and url are untouched.
// =============================================================================

export interface DominantAngleMember {
  /** Stable member key (`<itemType>:<itemId>`) — used only for deterministic tie-breaks. */
  key: string;
  title: string | null | undefined;
  /** 'corroborating' | 'attach' | 'anchor-only' — only corroborating members vote/win. */
  behaviorClass: string | null | undefined;
  /** ISO date / Date; older wins ties (the underlying event is reported first). */
  publishedAt?: string | Date | null;
  /**
   * False for members whose title should never become the displayed fallback
   * headline (video clips, podcasts, opinion pieces — often show-branded titles
   * like "… | Daybreak Europe 8/18/2026"). They still VOTE (their vocabulary
   * counts toward peers' overlap scores) but cannot WIN. Default: true.
   */
  eligibleToWin?: boolean;
}

// Minimal stopword set: strip glue words so overlap measures shared SUBJECT
// vocabulary, not shared English. Deliberately small and static.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'from', 'by', 'with', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'this', 'that', 'these', 'those', 'his', 'her', 'their', 'he',
  'she', 'they', 'we', 'you', 'i', 'not', 'no', 'will', 'would', 'can', 'could',
  'has', 'have', 'had', 'do', 'does', 'did', 'says', 'say', 'said', 'after',
  'over', 'into', 'amid', 'about', 'up', 'out', 'new', 'more', 'than', 'live',
  'updates', 'news', 'report', 'reports', 'breaking',
]);

export function titleTokens(title: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!title) return out;
  for (const raw of title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// A winner must average at least this much token overlap with its peers, or we
// treat the cluster's titles as too divergent to trust the heuristic (fail-open
// to the existing rep fallback). Chosen well below the ~0.5 same-headline band
// but above incidental one-word collisions.
const MIN_DOMINANT_SCORE = 0.12;

export interface DominantAnglePick {
  key: string;
  score: number;
}

/**
 * Pick the corroborating member whose title best overlaps the OTHER
 * corroborating members' titles. Returns null when no clear winner exists
 * (caller keeps the current rep fallback — fail-open).
 *
 * Deterministic: score desc → older publishedAt → lexicographic key.
 */
export function pickDominantAngleMember(
  members: DominantAngleMember[],
): DominantAnglePick | null {
  const scorable = members
    .filter((m) => m.behaviorClass === 'corroborating')
    .map((m) => ({ m, tokens: titleTokens(m.title) }))
    .filter((x) => x.tokens.size >= 3); // too-short titles neither vote nor win
  if (scorable.length < 2) return null;

  const scored = scorable
    .filter((x) => x.m.eligibleToWin !== false) // ineligible members vote but never win
    .map((x) => {
      let sum = 0;
      for (const other of scorable) {
        if (other === x) continue;
        sum += jaccard(x.tokens, other.tokens);
      }
      return { key: x.m.key, publishedAt: x.m.publishedAt, score: sum / (scorable.length - 1) };
    });
  if (scored.length === 0) return null;

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ta = a.publishedAt ? new Date(a.publishedAt as any).getTime() : NaN;
    const tb = b.publishedAt ? new Date(b.publishedAt as any).getTime() : NaN;
    const fa = Number.isFinite(ta);
    const fb = Number.isFinite(tb);
    if (fa && fb && ta !== tb) return ta - tb; // older first
    if (fa !== fb) return fa ? -1 : 1;
    return a.key.localeCompare(b.key);
  });

  const best = scored[0];
  if (best.score < MIN_DOMINANT_SCORE) return null; // no meaningful overlap anywhere
  return { key: best.key, score: best.score };
}
