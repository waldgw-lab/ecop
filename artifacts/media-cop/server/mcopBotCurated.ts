// server/mcopBotCurated.ts
// ---------------------------------------------------------------------------
// Pure, DB-free formatter that shapes the CURATED "Top Stories" payload
// (built by buildTopStoriesPayload in routes.ts, served by GET
// /api/curated/top-stories) into a compact, TRUST-TAGGED structure the MCOP
// Bot can reason over — WITHOUT ever exposing raw adversary/state-media article
// text as fact.
//
// SAFETY CONTRACT (the whole reason this file exists)
// ---------------------------------------------------
// The curated synthesis engine already guarantees the trust separation we need:
//   - a cluster's `lede` + `facts` are derived ONLY from CORROBORATING (trusted,
//     multi-source) members;
//   - adversary / contrast / state-media / low-factuality content survives only
//     as `attributedClaims` and per-member `spin`/`alignment`;
//   - standalone Top Stories are, by the read-path gate, always `contributing`.
//
// This formatter PRESERVES that separation structurally:
//   - `corroboratedFacts` / `summary` are populated ONLY from the synthesis
//     facts / lede (clusters) or the standalone contributing item's own bullets.
//     These may be stated as fact by the bot.
//   - `attributedClaims` and every non-corroborating source's `spin`/title go
//     into fields the bot is instructed to ALWAYS attribute and NEVER present as
//     verified fact.
// Adversary content therefore can NEVER land in `corroboratedFacts` — the bot
// can still say "Iranian state media said X" (via a source's spin / an attributed
// claim) but cannot pass it off as a verified fact.
//
// This module has NO database or AI imports so it is fully unit-testable and so
// it can never become an accidental back-door into the curated tables from a
// non-curated code path (the route injects it only when access is authorized).
// ---------------------------------------------------------------------------

/** How the bot must treat a given source's content. */
export type CuratedTrustClass = 'corroborating' | 'attributed';

export interface CuratedSourceForModel {
  source: string;
  /**
   * 'corroborating' = a trusted, corroborating outlet — content traceable to it
   * that appears in `corroboratedFacts` may be stated as fact.
   * 'attributed'    = single-source / official-primary / opinion / social OR
   * adversary/state-media/low-factuality — content traceable ONLY to it must be
   * attributed by name and never presented as verified fact.
   */
  trustClass: CuratedTrustClass;
  /** Convenience mirror of trustClass === 'corroborating'. */
  verifiedForFacts: boolean;
  /** Raw registry-derived lane role (contributing | anchor-only | attach-only). */
  role: string;
  title?: string;
  url?: string;
  /**
   * Per-outlet framing captured by synthesis for contrast/adversary members.
   * This is an UNVERIFIED, attribute-only signal (it is what lets the bot say
   * "<outlet> framed this as ..."). Never treat as fact.
   */
  spin?: string;
}

export interface CuratedStoryForModel {
  id: string;
  kind: 'cluster' | 'single';
  headline: string | null;
  /** Neutral, corroborated lede (clusters only). Fact-safe. Null for singles. */
  summary: string | null;
  /** Cross-checked facts (≥2 trusted outlets) — the bot MAY state these as fact. */
  corroboratedFacts: string[];
  /** Key statements — the bot MUST attribute these, never state as fact. */
  attributedClaims: string[];
  category: string | null;
  country: string | null;
  region: string | null;
  sourceCount: number;
  /** The outlets behind the story, each tagged with how the bot must treat it. */
  sources: CuratedSourceForModel[];
}

// Bounds so a curated tool result stays well within the tool-message size cap.
const MAX_STORIES = 60;
const MAX_FACTS = 12;
const MAX_CLAIMS = 12;
const MAX_SOURCES = 14;
const MAX_SPIN_CHARS = 500;

function toStringArray(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === 'string') {
      const t = x.trim();
      if (t) out.push(t);
    }
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Map the registry-derived lane role to how the bot must treat the source.
 * ONLY 'contributing' (a trusted, corroborating outlet) is fact-safe; every
 * other role (anchor-only official-primary OR contrast/adversary, and
 * attach-only social/opinion) is attribute-only. Fail-safe: anything we don't
 * recognize is treated as attribute-only.
 */
function trustClassForRole(role: unknown): CuratedTrustClass {
  return role === 'contributing' ? 'corroborating' : 'attributed';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function formatSource(m: any): CuratedSourceForModel {
  const trustClass = trustClassForRole(m?.role);
  const spinRaw = typeof m?.spin === 'string' ? m.spin.trim() : '';
  const out: CuratedSourceForModel = {
    source: typeof m?.source === 'string' ? m.source : 'Unknown source',
    trustClass,
    verifiedForFacts: trustClass === 'corroborating',
    role: typeof m?.role === 'string' ? m.role : 'attach-only',
  };
  const title = m?.displayTitle ?? m?.title;
  if (typeof title === 'string' && title.trim()) out.title = title.trim();
  if (typeof m?.url === 'string' && m.url) out.url = m.url;
  // A spin is an attribute-only framing signal; only meaningful (and only kept)
  // for non-corroborating sources so the bot can attribute it by name.
  if (spinRaw && trustClass === 'attributed') out.spin = truncate(spinRaw, MAX_SPIN_CHARS);
  return out;
}

function formatStory(s: any): CuratedStoryForModel {
  const isCluster = !!s?.clusterId;
  // FACT-SAFE fields only. Clusters: synthesis facts (corroborating-only) + lede.
  // Singles: the item's own bullets (standalone Top Stories are contributing by
  // the read-path gate). Adversary spins are NEVER read into this.
  const corroboratedFacts = isCluster
    ? toStringArray(s?.facts, MAX_FACTS)
    : toStringArray(s?.summaryBullets, MAX_FACTS);

  const sources: CuratedSourceForModel[] = isCluster
    ? (Array.isArray(s?.members) ? s.members.slice(0, MAX_SOURCES).map(formatSource) : [])
    : [formatSource({ source: s?.source, role: s?.role, title: s?.title, url: s?.url })];

  return {
    id: isCluster ? String(s?.clusterId) : `single:${s?.source ?? ''}:${s?.url ?? ''}`,
    kind: isCluster ? 'cluster' : 'single',
    headline: (typeof s?.headline === 'string' && s.headline) ? s.headline
      : (typeof s?.title === 'string' && s.title ? s.title : null),
    summary: isCluster && typeof s?.lede === 'string' && s.lede ? s.lede : null,
    corroboratedFacts,
    attributedClaims: toStringArray(s?.attributedClaims, MAX_CLAIMS),
    category: typeof s?.category === 'string' ? s.category : null,
    country: typeof s?.country === 'string' ? s.country : null,
    region: typeof s?.region === 'string' ? s.region : null,
    sourceCount: typeof s?.sourceCount === 'number' ? s.sourceCount : sources.length,
    sources,
  };
}

/**
 * Shape a top-stories payload (`{ stories: [...] }`) into the trust-tagged,
 * bounded structure the bot's curated tool returns. Pure — safe to unit-test.
 */
export function formatCuratedStoriesForModel(payload: any): CuratedStoryForModel[] {
  const stories = Array.isArray(payload?.stories) ? payload.stories : [];
  return stories.slice(0, MAX_STORIES).map(formatStory);
}

/**
 * Case-insensitive keyword filter over a story's headline, summary, facts,
 * attributed claims, and source names. Pure. Empty/omitted keywords → passthrough.
 */
export function filterCuratedStories(
  stories: CuratedStoryForModel[],
  keywords?: string[],
): CuratedStoryForModel[] {
  const terms = (keywords ?? [])
    .map((k) => (typeof k === 'string' ? k.trim().toLowerCase() : ''))
    .filter((k) => k.length >= 2);
  if (terms.length === 0) return stories;
  return stories.filter((s) => {
    const hay = [
      s.headline ?? '',
      s.summary ?? '',
      ...s.corroboratedFacts,
      ...s.attributedClaims,
      ...s.sources.map((src) => `${src.source} ${src.title ?? ''} ${src.spin ?? ''}`),
    ]
      .join(' \u0000 ')
      .toLowerCase();
    return terms.some((t) => hay.includes(t));
  });
}
