// =============================================================================
// Curated lane (Task #90) — STORY SYNTHESIS.
//
// The refinement layer on top of a FORMED curated story. For each clustered
// story we produce the "cluster-and-compare" payload the Curated view is built
// for:
//   1. A neutral, unbiased single-sentence LEDE.
//   2. 2-3 FACTS corroborated across DIVERSE contributing source TYPES —
//      diversity-weighted (agreement across DIFFERENT kinds of trusted sources),
//      NOT vote-counting. Adversary / attach-only sources NEVER contribute.
//   3. A per-source one-sentence SPIN characterization (for the expanded view),
//      covering BOTH contributing and attached members.
//
// The lede and facts derive ONLY from contributing trusted sources. Attached
// sources (adversary / opinion / social / video) appear for contrast and are fed
// to the model ONLY so it can characterize their spin — never the lede/facts.
//
// Source-type diversity uses the Outlet Registry `sourceIdentifier`
// (news-us-domestic / news-international / social-us-official / …); per-source
// spin can use each outlet's `factuality` grade as context.
//
// This module is import-only — it never reads/writes the DB directly. The
// clustering pass (server/curatedCluster.ts) calls synthesizeStory and persists
// the result via storage, keyed by synthesisSignature so it survives the
// per-pass cluster-id churn and only regenerates when membership changes.
// =============================================================================
import { openai, parseAiJson, isTransientAIError, aiResponseSnippet } from './aiClient';
import {
  recordCuratedAiCallOk,
  recordCuratedAiCallFailure,
  recordCuratedSynthJunkLines,
  recordCuratedSynthSkipRetry,
} from './curatedAiSpend';
import {
  deduplicateLines,
  excludeNearDuplicateLines,
  filterExplicitlyAttributedClaims,
  hasUnattributedSourceDependentAssertion,
} from './metaFiller';
import { withAiTimeout, AI_CALL_TIMEOUT_MS, AI_CALL_BACKSTOP_MS } from './aiTimeout';
import { createHash } from 'crypto';
import { SOURCE_IDENTIFIER_LABELS, type SourceIdentifier } from '@shared/outletRegistry';
import { normalizeIdentityUrl } from './urlIdentity';
import { normalizeTitle } from './titleNormalizer';
import { isMetaFillerLine } from './metaFiller';
import {
  groundGeneratedLinesInSources,
  groundGeneratedTextInSources,
} from './staleStatusSanitizer';


// A member of a story as far as synthesis is concerned. `key` is the stable
// `${itemType}:${itemId}` identifier shared with curated_cluster_members.
export interface SynthMember {
  key: string;
  // The article URL — the STABLE identity for a member. Used via
  // memberSignatureToken so the same article keeps ONE identity even when it
  // flips between a main:<id> and curated:<id> key across passes.
  url: string | null;
  source: string;
  sourceIdentifier: string | null;
  factuality: string | null;
  ownership?: string[];
  title: string;
  summary?: string | null;
  bullets?: string[] | null;
  cls: 'corroborating' | 'anchor-only' | 'attach';
  label: 'primary' | 'contrast' | null;
  // PROMPT-DISPLAY ONLY: the article's published/scraped timestamp. Rendered as a
  // relative age ("21 min ago", "18 hr ago") inside the member descriptor so the
  // model can identify which development is newest. MUST NOT enter
  // synthesisSignature, synthesisContentHash, or memberSignatureToken — relative
  // ages change each pass and would force needless re-synthesis every cycle.
  // Optional so existing callers and test fixtures that omit it stay compatible.
  publishedAt?: Date | string | null;
}

export interface SynthResult {
  // Short, generalized, neutral headline (NOT a full sentence) for the cluster.
  headline: string;
  lede: string;
  facts: string[];
  // `${itemType}:${itemId}` -> one-sentence spin characterization.
  spins: Record<string, string>;
  // `${itemType}:${itemId}` -> per-CONTRAST-source alignment breakdown: which of
  // the contrast source's own claims ALIGN with the corroborated facts and which
  // DIVERGE. Derived ONLY for contrast members; the corroborated facts themselves
  // are still built only from the corroborating (reliable) sources.
  alignments: Record<string, { align: string[]; diverge: string[]; pct: number }>;
  // Attributed claims / key statements across the cluster's sources (Task #256).
  // Each entry PRESERVES its source attribution ("The Pentagon said…", "Iranian
  // state media claimed…") and is shown additively beneath the corroborated
  // facts — NEVER folded into them (a claim is not a corroborated fact).
  attributedClaims: string[];
  // FALSE-MERGE backstop (Task #362). false ONLY when this would-be multi-source
  // story shows the structural tell of a false merge — every corroborated fact
  // traces to just ONE independently-owned contributor, so nothing is genuinely
  // shared across >= 2 independent owners. true in every other (incl. uncertain)
  // case, so it never fabricates corroboration it cannot prove. Curated-lane only.
  corroborated: boolean;
}

export interface SalvagedSynthesisDisplay {
  headline: string;
  lede: string;
  replacedHeadline: boolean;
  replacedLede: boolean;
}

/**
 * Remove only unsafe generated display fields instead of discarding an otherwise
 * useful synthesis. Replacement content must already have passed source
 * grounding and must not itself carry an obvious unattributed estimate or
 * assessment. The caller can still fail closed when no safe display text exists.
 */
export function salvageSynthesisHeadlineAndLede(input: {
  headline: string;
  lede: string;
  facts: ReadonlyArray<string>;
}): SalvagedSynthesisDisplay {
  const clean = (value: string | null | undefined): string => value?.trim() ?? '';
  const safe = (value: string | null | undefined): string => {
    const text = clean(value);
    return text && !hasUnattributedSourceDependentAssertion(text) ? text : '';
  };

  const originalHeadline = clean(input.headline);
  const originalLede = clean(input.lede);
  const safeHeadline = safe(originalHeadline);
  const safeLede = safe(originalLede);
  const safeFact = input.facts.map(safe).find(Boolean) ?? '';

  // Never salvage from a prior headline: it may describe a superseded phase of
  // the story and is not re-grounded against the current member set here.
  const headline = safeHeadline || safeLede || safeFact;
  const lede = safeLede || safeFact || headline;

  return {
    headline,
    lede,
    replacedHeadline: !!originalHeadline && headline !== originalHeadline,
    replacedLede: !!originalLede && lede !== originalLede,
  };
}

/**
 * Build the source oracle used to ground generated synthesis prose.
 *
 * Only original member titles are eligible. Member summaries and bullets are
 * themselves AI-generated enrichment, so allowing them to validate another AI
 * output creates a circular trust path: one stale identity substitution can
 * legitimize the same substitution in every synthesized field.
 */
export function buildSynthesisGroundingSourceTexts(
  members: ReadonlyArray<Pick<SynthMember, 'title'>>,
): string[] {
  return members
    .map((member) => member.title)
    .filter((title): title is string => typeof title === 'string' && title.trim().length > 0);
}

// One corroborated fact plus the CORROBORATING source keys that independently
// report it (as attributed by the synthesizer). Input to isLikelyFalseMerge.
export interface FactSupport {
  fact: string;
  sourceKeys: string[];
}

// Detect the structural tell of a FALSE MERGE (Task #362): a would-be
// multi-source story whose corroborated facts each trace to only ONE
// independently-owned contributor — no single fact genuinely shared across >= 2
// independent owners. PURE + deterministic (no LLM/DB) so it is unit-testable.
//
// Fail-closed against fabricating corroboration, but conservative against false
// dissolution: returns true ONLY when there is at least one attributed fact AND
// EVERY fact is attributed AND no fact reaches >= 2 distinct owners. Any of —
// no facts, a fact with no attribution, or any fact shared across >= 2 owners —
// returns false (do not dissolve). `ownerByKey` maps a member key to its
// ownership groups; `sourceByKey` is the per-key source-name fallback when
// ownership is unknown (two distinctly-named outlets still count as independent,
// but two facts from the SAME source never manufacture corroboration).
export function isLikelyFalseMerge(
  facts: FactSupport[],
  ownerByKey: Map<string, string[]>,
  sourceByKey: Map<string, string>,
): boolean {
  // No facts => a freshly-formed story whose members aren't enriched yet has no
  // facts to judge. Never dissolve on absence of evidence.
  if (facts.length === 0) return false;

  const ownersFor = (key: string): string[] => {
    const owners = (ownerByKey.get(key) ?? [])
      .map((o) => o.trim().toLowerCase())
      .filter(Boolean);
    if (owners.length) return owners;
    const src = (sourceByKey.get(key) ?? key).trim().toLowerCase();
    return src ? [src] : [];
  };

  let sawAttributedFact = false;
  for (const f of facts) {
    const keys = Array.from(new Set((f.sourceKeys ?? []).filter(Boolean)));
    // A fact with NO attribution can't be judged — the merge is unprovable, so
    // fail OPEN (don't dissolve) rather than guess.
    if (keys.length === 0) return false;
    sawAttributedFact = true;
    const owners = new Set<string>();
    for (const k of keys) for (const o of ownersFor(k)) owners.add(o);
    // A genuinely corroborated fact spans >= 2 distinct source keys AND >= 2
    // distinct owners. Any such fact clears the whole story.
    if (keys.length >= 2 && owners.size >= 2) return false;
  }
  // Every fact was attributed and single-owner => structural false-merge tell.
  return sawAttributedFact;
}

// Content signature for a story: sha256 of its sorted member keys. Stable across
// the clustering pass's per-run cluster-id regeneration, so synthesis is reused
// whenever a story's membership is unchanged and only recomputed when it churns.
// MUST be computed identically by the clustering pass and the read endpoints.
export function synthesisSignature(memberKeys: string[]): string {
  const sorted = Array.from(new Set(memberKeys)).sort();
  return createHash('sha256').update(sorted.join('|')).digest('hex');
}

// Normalize a URL for identity/dedup purposes. Delegates to the single shared
// normalizer (server/urlIdentity.ts) so the clustering pass, the read endpoints,
// and the archive all reduce the same article to the same token — including when
// it enters via two paths that differ only by a tracking query (e.g. an RSS
// feed's `?at_medium=RSS`). See urlIdentity.ts for the strip rules.
export function normalizeMemberUrl(u: string | null | undefined): string {
  return normalizeIdentityUrl(u);
}

// Stable identity token for a cluster member, used to compute BOTH the
// deterministic clusterId and the synthesis signature. Prefer the normalized
// article URL so a member keeps ONE identity even when it flips between its
// main:<id> and curated:<id> keys across passes (the curated store is a clone of
// the main feed). Fall back to the raw `${itemType}:${itemId}` key only for
// URL-less members. Deriving identity from the URL keeps the clusterId stable (no
// client detail-fetch churn) and the synthesis cache warm (no needless
// re-synthesis) across the key flip.
export function memberSignatureToken(url: string | null | undefined, key: string): string {
  return normalizeMemberUrl(url) || key;
}

// Secondary content hash for a FORMED story's synthesis: captures whether each
// member currently carries enrichment CONTEXT (an AI summary or bullets) the
// synthesizer can draw on. The membership-keyed signature alone cannot tell that
// a story FORMED before its members were enriched (image/bullets/summary arrive
// asynchronously) — without this, such a story would keep a titles-only lede
// forever. Re-synthesizing once when this hash changes lets the lede/facts fill
// in as context lands, without thrashing on every minor text tweak (member
// CONTEXT PRESENCE is hashed, not the text itself).
export function synthesisContentHash(members: SynthMember[]): string {
  const parts = members
    .map((m) => {
      const hasContext = !!((m.summary && m.summary.trim()) || (m.bullets && m.bullets.length));
      return `${memberSignatureToken(m.url, m.key)}=${hasContext ? 1 : 0}`;
    })
    .sort();
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) : s;
}

// Convert a publishedAt timestamp to a human-readable relative age string for
// prompt injection ("21 min ago", "18 hr ago", "3 days ago"). Returns empty
// string when no timestamp is present or it is unparseable. PROMPT-DISPLAY ONLY
// — never fed into any signature, hash, or identity computation.
function relativeAge(publishedAt: Date | string | null | undefined): string {
  if (!publishedAt) return '';
  const ms =
    typeof publishedAt === 'string'
      ? new Date(publishedAt).getTime()
      : (publishedAt as Date).getTime();
  if (!Number.isFinite(ms)) return '';
  const diffMin = Math.round((Date.now() - ms) / 60_000);
  if (diffMin < 0) return '';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  return `${Math.round(diffHr / 24)} days ago`;
}

// --- Wire-origin collapsing (Task #1111) ------------------------------------
// Detect byte-identical syndicated carriages of ONE wire story among the
// CORROBORATING members, reusing the same normalized-title identity the
// clustering must-link lane uses (normalizeTitle). Members sharing an identical
// normalized title (>= 4 title tokens, >= 2 distinct publisher names — the
// must-link guards, so trivial/short shared headlines and same-outlet clones
// never group) are ONE origin: however many outlets carry the copy, it is one
// wire story, not independent corroboration. Returns memberKey -> origin tag
// ("W1", "W2", …). PURE + exported for the headline-stability gate. PROMPT-ONLY:
// never enters any signature/hash/identity computation.
export function computeWireOriginGroups(members: SynthMember[]): Map<string, string> {
  const byTitle = new Map<string, SynthMember[]>();
  for (const m of members) {
    if (m.cls !== 'corroborating') continue;
    const norm = normalizeTitle(m.title ?? '').trim();
    if (!norm || norm.split(/\s+/).length < 4) continue;
    const arr = byTitle.get(norm);
    if (arr) arr.push(m);
    else byTitle.set(norm, [m]);
  }
  const out = new Map<string, string>();
  let i = 0;
  for (const group of Array.from(byTitle.values())) {
    const distinctSources = new Set(
      group.map((g: SynthMember) => (g.source ?? '').trim().toLowerCase()).filter(Boolean),
    );
    if (group.length < 2 || distinctSources.size < 2) continue;
    i++;
    for (const g of group) out.set(g.key, `W${i}`);
  }
  return out;
}

// Build the per-source descriptor block fed to the model. `wireTag`, when
// present, marks this member as a syndicated carriage of a shared wire origin.
function describeMember(m: SynthMember, wireTag?: string): string {
  const typeLabel = m.sourceIdentifier
    ? (SOURCE_IDENTIFIER_LABELS[m.sourceIdentifier as SourceIdentifier] ?? m.sourceIdentifier)
    : null;
  const type = typeLabel ? `, type=${typeLabel}` : '';
  const factuality = m.factuality ? `, factuality=${m.factuality}` : '';
  const owner = m.ownership && m.ownership.length ? `, ownership=${m.ownership.join('/')}` : '';
  const wire = wireTag ? `, wire-origin=${wireTag} (syndicated copy)` : '';
  // Relative age is prompt-display only — see publishedAt field comment on
  // SynthMember for why it must stay out of all identity/signature paths.
  // Only render when relativeAge() returns a non-empty string (i.e. a parseable,
  // non-future timestamp) so invalid/future values never produce a dangling token.
  const ageStr = relativeAge(m.publishedAt);
  const age = ageStr ? `, published=${ageStr}` : '';
  const ctx = m.summary
    ? ` :: ${truncate(m.summary, 300)}`
    : (m.bullets && m.bullets.length ? ` :: ${truncate(m.bullets.join(' '), 300)}` : '');
  return `[${m.key}] (${m.source}${type}${factuality}${owner}${wire}${age}) "${truncate(m.title, 240)}"${ctx}`;
}

/**
 * Synthesize a single formed story. Members fall into three behavior groups:
 *   - corroborating: trusted news — the ONLY group that informs lede + facts.
 *   - anchor-only/primary: official origin source ("X announced…") — attributed,
 *     never folded into corroborated facts.
 *   - anchor-only/contrast + attach: shown for contrast/spin only.
 * Returns null when there are no corroborating sources (fail-closed) or when the
 * model call fails — callers fall back to the raw representative.
 */
// Threshold (hours) at which the corroborating block is split into RECENT and
// BACKGROUND sections. When the oldest corroborating member is more than this many
// hours older than the newest, the prompt directs the model to anchor
// headline/lede/facts on the RECENT block and treat the BACKGROUND block as arc
// context only. PROMPT-DISPLAY ONLY — never affects signatures or hashes.
export const RECENCY_SPLIT_H = 12;
const RECENCY_SPLIT_MS = RECENCY_SPLIT_H * 60 * 60 * 1000;

// Build the synthesis prompt for a formed story. PURE (no LLM/DB) and exported so
// the dominant-development anchor-fidelity contract is regression-testable without
// a network call. synthesizeStory verifies there is >= 1 corroborating member
// before calling this.
//
// opts.priorHeadline (headline-stability fix): when a story re-synthesizes while
// it already carries a valid cached headline (member-set churn / stale-synopsis
// refresh), the prior headline is passed in as a CONTINUITY ANCHOR. The
// consolidation lane's pass-to-pass oscillation made ~half of all formed stories
// re-synthesize every ~10-min pass; each re-roll was a fresh chance for the model
// to reword a good neutral headline into an editorialized one. The anchor tells
// the model to KEEP the prior headline unless the dominant development materially
// changed or the HEADLINE RECENCY RULE licenses an update — so wording persists
// across membership churn while genuine developments still update the headline.
export function buildSynthesisPrompt(
  members: SynthMember[],
  opts?: { priorHeadline?: string },
): string {
  const corroborating = members.filter((m) => m.cls === 'corroborating');
  const primary = members.filter((m) => m.cls === 'anchor-only' && m.label === 'primary');
  const contrast = members.filter(
    (m) => m.cls === 'attach' || (m.cls === 'anchor-only' && m.label === 'contrast'),
  );

  // Wire-origin collapsing (Task #1111): tag byte-identical syndicated
  // carriages so the model counts them as ONE origin in every corroboration
  // test. PROMPT-ONLY.
  const wireOrigins = computeWireOriginGroups(members);
  const describe = (m: SynthMember) => describeMember(m, wireOrigins.get(m.key));

  // Detect long-lived cluster time span: if the oldest corroborating member is
  // >RECENCY_SPLIT_H older than the newest, split the corroborating block into a
  // RECENT section (≤RECENCY_SPLIT_H from the newest) and a BACKGROUND section
  // (>RECENCY_SPLIT_H from the newest). The model anchors headline/lede/facts on
  // the RECENT block (still requiring ≥2 distinct owners), using BACKGROUND only
  // to establish the story arc. PROMPT-ONLY — never affects signatures or hashes.
  const corrobPubMsArr = corroborating.map((m) => {
    const ms = m.publishedAt ? new Date(m.publishedAt as string).getTime() : NaN;
    return Number.isFinite(ms) ? ms : NaN;
  });
  const datedMs = corrobPubMsArr.filter((ms) => Number.isFinite(ms));
  const newestMs = datedMs.length ? Math.max(...datedMs) : null;
  const oldestMs = datedMs.length ? Math.min(...datedMs) : null;
  const useRecencySplit =
    newestMs != null && oldestMs != null && newestMs - oldestMs > RECENCY_SPLIT_MS;

  let corroboratingBlock: string;
  let recencyAnchorNote: string;
  if (useRecencySplit) {
    // Recent: within RECENCY_SPLIT_H of the newest dated member.
    // Background: >RECENCY_SPLIT_H older than newest, or no parseable date (conservative).
    const recent = corroborating.filter((_, i) => {
      const ms = corrobPubMsArr[i];
      return Number.isFinite(ms) && newestMs! - ms <= RECENCY_SPLIT_MS;
    });
    const background = corroborating.filter((_, i) => {
      const ms = corrobPubMsArr[i];
      return !Number.isFinite(ms) || newestMs! - ms > RECENCY_SPLIT_MS;
    });
    const recentBlock = recent.length ? recent.map(describe).join('\n') : '(none)';
    const backgroundBlock = background.length ? background.map(describe).join('\n') : '(none)';
    corroboratingBlock =
      `RECENT CORROBORATING (≤${RECENCY_SPLIT_H}h old — anchor headline/lede/facts here):\n${recentBlock}` +
      `\n\nBACKGROUND CONTEXT (>${RECENCY_SPLIT_H}h old — arc context only, NEVER the anchor):\n${backgroundBlock}`;
    recencyAnchorNote =
      `\nRECENCY ANCHOR RULE (applies because this cluster spans >${RECENCY_SPLIT_H} hours):` +
      ` The RECENT CORROBORATING block represents where the story NOW stands.` +
      ` The headline, lede, and FIRST corroborated fact MUST reflect the RECENT block's dominant` +
      ` development (the one independently reported by ≥2 distinctly-owned outlets in the RECENT block).` +
      ` The BACKGROUND CONTEXT block reveals how the story originated — use it only to understand the arc.` +
      ` A background development that is no longer the leading edge goes to "attributedClaims" at most;` +
      ` it must never reclaim the headline or first fact.`;
  } else {
    corroboratingBlock = corroborating.map(describe).join('\n');
    recencyAnchorNote = '';
  }

  const primaryBlock = primary.length ? primary.map((m) => describeMember(m)).join('\n') : '(none)';
  const contrastBlock = contrast.length ? contrast.map((m) => describeMember(m)).join('\n') : '(none)';

  // Distinct contributing source TYPES present — surfaced to the model so it
  // weights corroboration by diversity of type rather than raw count.
  const distinctTypes = Array.from(
    new Set(
      corroborating
        .map((m) =>
          m.sourceIdentifier
            ? (SOURCE_IDENTIFIER_LABELS[m.sourceIdentifier as SourceIdentifier] ?? m.sourceIdentifier)
            : null,
        )
        .filter(Boolean) as string[],
    ),
  );
  // Distinct OWNERSHIP entities among corroborating sources — independent
  // ownership is the strongest signal that agreement is genuine, not syndication.
  const distinctOwners = Array.from(
    new Set(corroborating.flatMap((m) => m.ownership ?? []).filter(Boolean)),
  );

  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Continuity anchor (headline-stability fix). Truncated + quote-sanitized so a
  // pathological stored headline can never break the prompt structure. Placed
  // directly after the HEADLINE RECENCY RULE so the precedence reads in order:
  // recency rule beats continuity, continuity beats a fresh reword.
  const prior = (opts?.priorHeadline ?? '').replace(/["\n\r]/g, ' ').trim().slice(0, 200);
  const continuityNote = prior
    ? `\n\nHEADLINE CONTINUITY: A previous edition of this brief used the headline: "${prior}". KEEP this exact headline unless the dominant development has materially changed or the HEADLINE RECENCY RULE above licenses an update. A change in which sources are attached to the cluster is NOT by itself a reason to reword — the same development keeps the same headline. If a change IS warranted, still use measured wire-service wording.`
    : '';

  return `You are an unbiased intelligence editor building a "cluster-and-compare" brief for ONE news story that multiple outlets are covering.

TODAY'S DATE: ${todayStr}. The source articles provided below are the SOLE authority for every person's current title and office. Refer to each person using EXACTLY the name and title the source articles use — NEVER add status qualifiers (former, ex-, then-, late, incumbent, current) from your background knowledge. If the sources call someone "President X", write "President X"; if they call someone "Secretary Y", write "Secretary Y". Do not use "Former" or "Ex-" for any person unless those exact words appear in the source text for that person.

CORROBORATING SOURCES (trusted news — these, and ONLY these, may inform the neutral lede and the corroborated facts):
${corroboratingBlock}

PRIMARY / ORIGIN SOURCES (official releases — the originator of the news, e.g. a government statement. ATTRIBUTE their claims to them ("X announced…"); NEVER fold them into the corroborated facts):
${primaryBlock}

CONTRAST SOURCES (adversary / opinion / social / low-credibility — shown for CONTRAST ONLY. They must NEVER influence the lede or the corroborated facts. Use them only to characterize their own spin):
${contrastBlock}

Distinct corroborating source TYPES present: ${distinctTypes.length ? distinctTypes.join(', ') : 'unknown'}.
Distinct corroborating OWNERSHIP groups present: ${distinctOwners.length ? distinctOwners.join(', ') : 'unknown'}.${wireOrigins.size ? `\nWIRE-ORIGIN NOTE: members tagged with the same wire-origin=… value carry a byte-identical syndicated headline — they are carriages of ONE underlying wire story. They count as ONE origin (one owner) in EVERY "≥2 distinctly-owned corroborating outlets" test in this prompt (dominant-development anchoring, the HEADLINE RECENCY RULE, the loaded-verb exception, and the HEADLINE CAUSAL-NEUTRALITY RULE). Never treat syndicated copies as independent corroboration.` : ''}

ANCHOR ON THE DOMINANT DEVELOPMENT. First identify this cluster's DOMINANT development — the single development that the WIDEST set of DISTINCTLY-OWNED corroborating outlets (and the widest range of source TYPES) are reporting. The lede and the FIRST corroborated fact MUST reflect that dominant development. Do NOT anchor them on a single high-priority, dramatic, alarmist, or peripheral angle that only one or two owners carry while most corroborating owners report a different main development — relegate such minority angles to "attributedClaims" or "spins", never the lede/facts. When the cluster covers a multi-step DEVELOPING PROCESS (an ongoing negotiation, deal, agreement, summit, or its consequences and terms), treat the whole process as ONE story and lead with the most-broadly-corroborated CURRENT development of that process. For such a long-running story, use the "published=…" timestamps to find the LATEST turn: when a newer development of that process is reported by ≥2 DISTINCTLY-OWNED corroborating outlets, the lede and the FIRST corroborated fact MUST reflect WHERE THE STORY NOW STANDS, not the original announcement — even if the original was reported by more outlets overall. This does NOT relax corroboration: a newer turn carried by only one owner stays in "attributedClaims", never the lede/facts.

HEADLINE RECENCY RULE (applies to the "headline" key ONLY — lede and facts are unchanged). Use the "published=…" timestamps in each member descriptor to identify whether a LATER development SUPERSEDES or REVERSES the earlier announcement within the same story. If ≥2 DISTINCTLY-OWNED corroborating outlets report that later development, the headline MUST convey the trajectory or the latest state (e.g. "Trump drops Hormuz fee in favor of Gulf investment deals") even if the original announcement was reported by more outlets overall. A single-outlet "latest turn" can NEVER hijack the headline — the broadest-corroborated dominant development still wins whenever the newer turn has fewer than 2 distinctly-owned corroborating sources. When the later development qualifies, the headline must reflect WHERE THE STORY NOW STANDS, not where it started. The minority-angle guard is unchanged: a dramatic or alarmist claim from only one or two owners goes to "attributedClaims", never the headline.

EVIDENCE CLASSIFICATION — DO THIS BEFORE WRITING. Classify every candidate proposition as one of: (A) an observable/reported development (an event occurred, a person spoke or met, a measured quantity, a location, timing, or documented scope); (B) an announcement, commitment, intention, policy position, denial, or participant account; (C) a motive, cause, explanation, forecast, prediction, or evaluative characterization. Only category A may become an unattributed "fact", and only when independently supported by ≥2 distinct origins. Categories B and C ALWAYS remain explicitly attributed claims even when many outlets repeat the same speaker's statement; repeated carriage does not convert an assertion into fact. A fact may report the observable act that a statement or denial occurred, but must not flatten the statement's content into settled truth.

CORROBORATED DISAGREEMENT RULE. If recent trusted reporting from ≥2 DISTINCTLY-OWNED corroborating outlets materially denies, contradicts, or disputes an earlier announcement or participant account, the headline and lede MUST describe the disagreement or trajectory (for example, "Trump announces talks as Iran denies negotiations") rather than present either side's account as settled fact. Attribute both sides in the lede where needed for accuracy. This rule updates the framing only after the contradiction itself is independently reported by ≥2 distinct origins; one newly attached source introducing a denial, reversal, deal, attack, or other different turn NEVER displaces the established framing and belongs only in "attributedClaims" until independently reported.

HEADLINE CAUSAL-NEUTRALITY RULE (constrains EVERY other headline rule, including the HEADLINE RECENCY RULE and any continuity anchor): a MOTIVE or CAUSAL characterization — WHY an actor did something, what a move "gives room" for, signals, aims at, or is intended to achieve — may be stated as unattributed headline fact ONLY when that explanation is reported in the outlets' OWN voice by ≥2 distinct ORIGINS (byte-identical / same-wire syndicated carriages count as ONE origin; a single official's quoted characterization, however many outlets carry the quote, is ONE actor's claim and NEVER corroboration). When a causal framing fails this test, state the observable development neutrally in the headline and either DROP the causal framing or move it, attributed, to "attributedClaims". If a prior/continuity headline contains single-origin causal framing, reword it neutrally — continuity never preserves single-origin causal framing.${recencyAnchorNote}${continuityNote}

Produce a JSON object with exactly these keys:
1. "headline": a SHORT, neutral, newspaper-style headline (aim for 6-12 words) capturing the cluster's DOMINANT development — or, when the HEADLINE RECENCY RULE applies (a later development that supersedes or reverses the original is independently reported by ≥2 distinctly-owned corroborating outlets), the LATEST STATE of the story. This is NOT a sentence: no trailing period, no judgment adjectives, no spin. Use measured, wire-service verbs — never loaded or dramatic verbs and framings (e.g. "demands", "slams", "blasts", "rebukes", "defies", "raises fears") unless that word is itself the corroborated development independently reported by ≥2 distinctly-owned corroborating outlets. Generalize across the corroborating sources — never adopt one outlet's specific framing, and never lead with a minority/alarmist angle carried by only a few owners. Observable category-A developments need no source attribution in the headline, but if the headline's central proposition is category B or C — including an unnamed-source estimate, readiness assessment, concern, cause, prediction, denial, or characterization — the headline MUST visibly attribute it to the actual originator or unnamed-source class (e.g. "Officials say U.S. used nearly all long-range missiles"). Never turn "sources say" into an unattributed declaration merely because several outlets carried it. It MUST be distinct from, and clearly shorter than, the lede.
2. "lede": ONE neutral, unbiased sentence summarizing the cluster's DOMINANT development. No adjectives of judgment or spin. Derive it ONLY from the corroborating sources. Normally state a category-A observable development directly. Any category-B/C assertion used in the lede — including an unnamed-source estimate, concern, readiness assessment, cause, prediction, denial, or characterization — MUST name its actual originator or unnamed-source class and use an explicit attribution verb. When the CORROBORATED DISAGREEMENT RULE applies, explicitly attribute the competing announcement and denial so neither account is presented as settled fact.
3. "facts": an array of 2-3 short statements limited to category-A observable/reported developments that are CORROBORATED ACROSS INDEPENDENTLY-OWNED, DIFFERENT KINDS of corroborating sources. Prioritize concrete events, measurements, places, timing, and scope. Announcements, intentions, commitments, denials, motives, causes, explanations, forecasts, predictions, policy positions, and evaluative characterizations NEVER become unattributed facts; place their content in "attributedClaims" with its actual originator. The FIRST fact MUST state the cluster's DOMINANT observable development — the one carrying the BROADEST distinct-OWNER corroboration — so the facts reflect what most independent owners actually report, not a minority angle. Weight by OWNERSHIP DISTINCTNESS and source-TYPE diversity, NOT by how many outlets repeat it: a fact agreed by two DIFFERENTLY-OWNED outlets of different types is far stronger than a fact repeated by five outlets that share an owner or type (likely the same wire copy). NEVER use a claim that only appears in primary or contrast sources. If fewer than 2 facts are genuinely corroborated across distinct ownership, return only the ones that are (an empty array is acceptable rather than inventing agreement). COMPETING EXPLANATIONS: when corroborating sources offer MORE THAN ONE explanation and a SECOND explanation is independently reported by ≥2 distinct origins (never counting syndicated copies twice), include that competing explanation in "attributedClaims" with its actual originator instead of omitting it or presenting it as fact. Never drop a mainstream-corroborated explanation merely because contrast sources also amplify it.
4. "spins": an object mapping EACH source key (corroborating, primary AND contrast, exactly as bracketed above, e.g. "main:abc" or "curated:def") to ONE sentence characterizing that outlet's particular angle, framing, or spin on this story. For neutral wire coverage say so plainly; for primary sources name what they are asserting; for adversary/opinion outlets name the slant.
5. "alignments": an object mapping ONLY each CONTRAST source key (the ones listed under CONTRAST SOURCES above) to an object {"align": [...], "diverge": [...], "pct": N}. "align" lists that contrast source's OWN claims/framings that AGREE WITH or are consistent with the corroborated facts; "diverge" lists its claims/framings that CONTRADICT, distort, omit, or spin away from the corroborated facts. Be discerning: a contrast source's framing often diverges through unwarranted certainty, selective emphasis, omission, or one-sided sourcing even when its bare facts overlap — capture those in "diverge". Only leave "diverge" empty when the source's coverage is genuinely consistent with the corroborated facts. Each entry MUST be a SHORT, SUBJECTLESS third-person verb phrase that grammatically completes the sentence "It ___" — it MUST begin with a lowercase verb (e.g. "confirms the strike occurred", "downplays civilian casualties", "omits the U.N. findings"). Do NOT begin an entry with its own subject or a proper noun (write "claims the talks may collapse", never "Israeli attacks may derail talks"); proper nouns that appear later in the phrase stay capitalized. A few words to one clause, 0-3 per list. "pct" is an INTEGER 0-100 estimating the share of that source's overall framing on this story that aligns with the corroborated facts (100 = fully consistent; lower as divergence, spin, or omission grows) — judge it holistically, NOT merely as a ratio of the bullet counts. Judge alignment ONLY against the corroborated facts — never let a contrast source's claim become a fact. Include a key here ONLY for contrast sources; do NOT add corroborating or primary sources to "alignments". If there are no contrast sources, return an empty object.
6. "attributedClaims": an array of 0-4 short ATTRIBUTED claims or on-the-record statements drawn from ANY of the sources above (corroborating, primary, OR contrast). Select the most decision-relevant claims that ADD information not already stated in "facts"; NEVER repeat the same proposition in both sections merely by adding attribution. EVERY ENTRY MUST BE SELF-CONTAINED AND VISIBLY ATTRIBUTED: name the underlying speaker, agency, document, or unnamed-source class and use a clear attribution verb such as "said", "reported", "estimated", "assessed", "warned", "claimed", or "according to". The section label is not attribution. Never write bare assertions such as "The U.S. has depleted nearly all long-range missiles" or "The depletion raises concerns about readiness"; write "U.S. officials told Reuters that..." or "Defense analysts warned that..." when those origins are supported. PRESERVE the MOST SPECIFIC attribution the underlying article actually provides: if it names a person, use that person's full name plus title/affiliation when given, rather than collapsing them into "an expert said". Only use a generic descriptor ("an official said") or "sources said" when the article genuinely does not name the source. Attribute a claim to an outlet only when the outlet itself originated the reporting, investigation, analysis, or editorial judgment — never when it merely carried another actor's words. These are NOT corroborated facts: announcements, commitments, intentions, denials, participant explanations, causal accounts, forecasts, concerns, readiness assessments, source-based estimates, and characterizations belong here even when multiple outlets quote them. Keep each entry 25 words or fewer; spell out outlet/organization names in full. If no clearly attributed, non-duplicative claims stand out, return an empty array.
7. "factSources": an array ALIGNED 1:1 with "facts" (same order, same length). factSources[i] is the array of CORROBORATING source keys (from the CORROBORATING SOURCES block ONLY, exactly as bracketed, e.g. "main:abc") that INDEPENDENTLY report facts[i]. List EVERY corroborating source that supports that fact: a fact only one corroborating source reports has a SINGLE-element array; a fact genuinely agreed by two independently-owned corroborating outlets lists BOTH their keys. Do NOT pad the list — never add a key for a source that does not actually report that fact. NEVER include primary or contrast keys here.

All text outputs (headline, lede, facts, spins, alignments, attributedClaims) MUST be written in English regardless of the source language of any member headlines.

NEVER output meta-commentary about the coverage or source material itself as a fact or claim (e.g. "The article does not provide further details", "Specifics were not specified in the excerpt") — omit the entry instead. Every fact and claim must state news content.

Return ONLY valid JSON, no markdown, no commentary.

Example shape:
{"headline":"...","lede":"...","facts":["fact A","fact B"],"factSources":[["main:abc","curated:xyz"],["main:abc"]],"spins":{"main:abc":"...","curated:def":"..."},"alignments":{"curated:def":{"align":["confirms the strike occurred"],"diverge":["claims no casualties, contradicting reports","frames it as self-defense"],"pct":40}},"attributedClaims":["The Pentagon said no U.S. troops were involved","Iranian state media claimed the strike was repelled"]}`;
}

// --- Curated synthesis model chain (Claude Sonnet primary) -----------------
// Story synthesis (and the contrast alignment %) is a Tier-1 curated reasoning
// job: neutral multi-document summarization where Claude Sonnet's stronger
// instruction-following ("summarize without editorializing") pays off. So Claude
// Sonnet is the PRIMARY, gpt-4o is the automatic fallback, and a fast Claude
// haiku is the last resort — mirroring the curated clustering chain. We only step
// to the next model on a TRANSIENT provider failure (429 / 5xx / network / open
// breaker, gated via the shared isTransientAIError); a genuine error (bad prompt,
// malformed request) surfaces immediately so the caller's fail-safe runs. This is
// CURATED-LANE ONLY and uses the shared aiClient unchanged — no other lane and no
// cheap extraction call is affected. NOTE: synthesis runs per FORMED Top Story
// (higher volume than clustering's few batch calls), so the gpt-4o fallback must
// reliably cover Claude credit exhaustion (402, surfaced as a provider failure).
const CURATED_SYNTHESIS_MODEL_CHAIN = [
  'anthropic/claude-sonnet-4.5', // primary: neutral multi-doc summarization
  'gpt-4o', // fallback 1: comparable reasoning, different provider
  'anthropic/claude-haiku-4.5', // fallback 2: fast last resort
];

type SynthesisCreateBody = Parameters<typeof openai.chat.completions.create>[0];

// Test-only injection seam (Task #987). ESM named imports are read-only, so a
// regression test cannot reassign the imported `openai.chat.completions.create`
// to simulate a blocking provider call. This nullable override lets the
// clustering-timeout test inject a stub WITHOUT a mocking framework; production
// always leaves it null and uses the real shared client unchanged, so it
// changes no production behavior.
let curatedSynthesisCompletionOverride: typeof openai.chat.completions.create | null = null;
export function __setCuratedSynthesisCompletionForTest(
  fn: typeof openai.chat.completions.create | null,
): void {
  curatedSynthesisCompletionOverride = fn;
}

// Race a promise against an AbortSignal so the clustering pass's hard timeout
// releases an in-flight synthesis call immediately with an AbortError instead of
// waiting for withAiTimeout's own backstop. Curated-lane only.
function raceWithAbortSynthesis<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    const err = new Error('Curated synthesis cancelled (signal already aborted)');
    err.name = 'AbortError';
    return Promise.reject(err);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      const err = new Error('Curated synthesis cancelled (abort while in flight)');
      err.name = 'AbortError';
      reject(err);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

async function createCuratedSynthesisCompletion(
  body: SynthesisCreateBody,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof openai.chat.completions.create>>> {
  let lastErr: unknown;
  const create = curatedSynthesisCompletionOverride ?? openai.chat.completions.create.bind(openai.chat.completions);
  for (let i = 0; i < CURATED_SYNTHESIS_MODEL_CHAIN.length; i++) {
    const model = CURATED_SYNTHESIS_MODEL_CHAIN[i];
    try {
      // THREE-LAYER hang protection:
      // 1. SDK-level per-request timeout aborts the HTTP request at the source.
      // 2. withAiTimeout race backstop catches any path the SDK timeout misses.
      // 3. raceWithAbortSynthesis: races the call against the clustering pass's own
      //    AbortSignal (Task #987) so the 10-min hard timeout releases an in-flight
      //    synthesis call IMMEDIATELY instead of waiting for the backstop ceiling.
      // trackStorm: false — curated synthesis must stay isolated from the main-feed
      // storm detector in both directions.
      const result = await raceWithAbortSynthesis(
        withAiTimeout(
          create(
            { ...body, model },
            { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 },
          ),
          AI_CALL_BACKSTOP_MS,
          `curatedSynthesis(${model})`,
          { trackStorm: false },
        ),
        signal,
      );
      if (i > 0) {
        console.warn(
          `[CuratedSynthesis] synthesis served by fallback model "${model}" (primary was rate-limited)`,
        );
      }
      // Spend telemetry (Task #1100) — log-only aggregation, never alters the
      // response. `result.model` is the model that ACTUALLY served (the shared
      // client's cross-provider fallback stamps the real serving model even
      // when this chain entry asked for a different one).
      recordCuratedAiCallOk('synthesis', result, model);
      return result;
    } catch (err) {
      lastErr = err;
      const isLast = i === CURATED_SYNTHESIS_MODEL_CHAIN.length - 1;
      // Only a TRANSIENT provider failure is worth trying another provider; a
      // genuine error won't be fixed by it, so re-throw it immediately.
      if (isLast || !isTransientAIError(err)) {
        recordCuratedAiCallFailure('synthesis'); // telemetry only (Task #1100)
        throw err;
      }
      console.warn(
        `[CuratedSynthesis] model "${model}" transiently unavailable; trying "${CURATED_SYNTHESIS_MODEL_CHAIN[i + 1]}"`,
      );
    }
  }
  throw lastErr;
}

// Recency-window caps for the synthesis prompt. Applied BEFORE buildSynthesisPrompt
// so megaclusters don't flood the context with 140+ member descriptors, which
// consumes the token budget on old "Trump weighing options" coverage before the
// model can see the current "active strikes / Hormuz threat" articles. The caps
// are PROMPT-ONLY: synthesisSignature, synthesisContentHash, and
// freshestContribMs are ALL computed from the FULL member list by curatedCluster.ts
// before calling synthesizeStory, so caching and stale-synopsis self-termination
// are completely unaffected.
const SYNTH_CAP_CORROBORATE_RECENT = 25; // most-recently-published corroborating members
const SYNTH_CAP_CORROBORATE_BACKGROUND = 10; // oldest corroborating members (arc context)
const SYNTH_CAP_CONTRAST = 20; // attach / contrast members

// Token budget scales with the capped member count so attributed claims and
// alignment entries are not truncated on large-cluster synthesis calls.
const SYNTH_TOKENS_NORMAL = 4000;
const SYNTH_TOKENS_LARGE = 6000;
const SYNTH_LARGE_MEMBER_THRESHOLD = 30; // total capped members that triggers the larger budget

export async function synthesizeStory(
  members: SynthMember[],
  signal?: AbortSignal,
  opts?: { priorHeadline?: string },
): Promise<SynthResult | null> {
  const corroborating = members.filter((m) => m.cls === 'corroborating');
  if (corroborating.length === 0) return null;

  // --- Recency-capped member selection (Step 1 of Task #954) ---
  // Sort corroborating by publishedAt descending so the most-recent land first.
  // Members without a parseable timestamp sort to the END (treated as oldest).
  const sortedCorroborating = [...corroborating].sort((a, b) => {
    const msA = a.publishedAt ? new Date(a.publishedAt as string).getTime() : NaN;
    const msB = b.publishedAt ? new Date(b.publishedAt as string).getTime() : NaN;
    if (!Number.isFinite(msA) && !Number.isFinite(msB)) return 0;
    if (!Number.isFinite(msA)) return 1;
    if (!Number.isFinite(msB)) return -1;
    return msB - msA; // newest first
  });
  // Keep at most SYNTH_CAP_CORROBORATE_RECENT of the freshest articles as the
  // primary pool, then at most SYNTH_CAP_CORROBORATE_BACKGROUND of the oldest
  // articles as background context. Members that fall in both windows (small
  // clusters) are naturally deduplicated since we take slices from the sorted
  // array — recent takes [0..N] and background takes [-(M)..end].
  const recentPool = sortedCorroborating.slice(0, SYNTH_CAP_CORROBORATE_RECENT);
  const recentKeys = new Set(recentPool.map((m) => m.key));
  // Background: the last BACKGROUND items in date-descending order (i.e. oldest).
  // Exclude any already in recentPool to prevent duplicates when the cluster is
  // small enough that the pools would overlap.
  const backgroundPool = sortedCorroborating
    .slice(-SYNTH_CAP_CORROBORATE_BACKGROUND)
    .filter((m) => !recentKeys.has(m.key));

  // Contrast / attach: hard-cap to keep the prompt size bounded.
  const contrastAndAttach = members
    .filter((m) => m.cls === 'attach' || (m.cls === 'anchor-only' && m.label === 'contrast'))
    .slice(0, SYNTH_CAP_CONTRAST);
  const primaryMembers = members.filter(
    (m) => m.cls === 'anchor-only' && m.label === 'primary',
  );

  // Reassemble the capped member list: recent corroborating first (ordered
  // newest→oldest within each group), then background, then primary, then
  // contrast/attach.
  const cappedMembers: SynthMember[] = [
    ...recentPool,
    ...backgroundPool,
    ...primaryMembers,
    ...contrastAndAttach,
  ];

  const prompt = buildSynthesisPrompt(cappedMembers, opts);

  // Scale the token budget with the total capped member count so attributed
  // claims and alignment entries are not truncated on large-cluster synthesis.
  const maxTokens =
    cappedMembers.length > SYNTH_LARGE_MEMBER_THRESHOLD
      ? SYNTH_TOKENS_LARGE
      : SYNTH_TOKENS_NORMAL;

  try {
    const response = await createCuratedSynthesisCompletion({
      // Model is overridden per-attempt by the chain helper above (Claude Sonnet
      // primary -> gpt-4o fallback). The string here is a no-op placeholder.
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      // A multi-source story emits a per-source "spins" map plus per-contrast
      // "alignments" — a large cluster overflows a tight cap and truncates the
      // reply mid-JSON (unterminated fence -> parse failure -> story dropped).
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }, signal);
    const content = response.choices[0]?.message?.content?.trim();
    if (!content) {
      console.warn('[CuratedSynthesis] MALFORMED AI response (empty content) — story not synthesized this pass (cluster preserved, retries next pass)');
      recordCuratedSynthSkipRetry(); // telemetry only (Task #1100)
      return null;
    }

    const parsed = parseAiJson<{
      headline?: unknown;
      lede?: unknown;
      facts?: unknown;
      factSources?: unknown;
      spins?: unknown;
      alignments?: unknown;
      attributedClaims?: unknown;
    }>(content);
    if (!parsed) {
      // Malformed payload (unparseable even after fence-stripping), distinct from
      // an API/network failure (thrown by the create() call above and caught
      // below). Fail-safe: return null so the caller keeps the cluster and just
      // skips synthesis this pass — no member is dropped, it retries next pass.
      console.warn(`[CuratedSynthesis] MALFORMED AI response (could not parse JSON) — story not synthesized this pass (cluster preserved, retries next pass) :: ${aiResponseSnippet(content)}`);
      recordCuratedSynthSkipRetry(); // telemetry only (Task #1100)
      return null;
    }

    const headline = typeof parsed.headline === 'string' ? parsed.headline.trim() : '';
    const lede = typeof parsed.lede === 'string' ? parsed.lede.trim() : '';
    // Keep each kept fact's ORIGINAL index so factSources (aligned 1:1 with the
    // model's facts array) can be matched back after empties are filtered out.
    // Meta-filler "facts" ("The article does not provide further details…") are
    // dropped HERE, inside the entry builder, so factSources index alignment is
    // preserved for the surviving facts.
    const rawFacts = Array.isArray(parsed.facts) ? parsed.facts : [];
    const factEntries: Array<{ fact: string; idx: number }> = [];
    // Junk/meta-filler detector hits (Task #1100) — counted for the per-pass
    // spend/quality summary only; the kept/dropped sets are unchanged.
    let junkLinesDropped = 0;
    rawFacts.forEach((f, i) => {
      if (typeof f === 'string' && f.trim()) {
        if (isMetaFillerLine(f)) {
          junkLinesDropped++;
        } else {
          factEntries.push({ fact: f.trim(), idx: i });
        }
      }
    });
    const keptFacts = factEntries.slice(0, 3);
    const facts = keptFacts.map((e) => e.fact);

    const validKeys = new Set(members.map((m) => m.key));
    const spins: Record<string, string> = {};
    if (parsed.spins && typeof parsed.spins === 'object') {
      for (const [k, v] of Object.entries(parsed.spins as Record<string, unknown>)) {
        if (validKeys.has(k) && typeof v === 'string' && v.trim()) {
          spins[k] = v.trim();
        }
      }
    }

    // Alignment breakdown is ONLY meaningful for contrast members — clamp to that
    // set so a stray corroborating/primary key from the model can never imply a
    // reliable source "diverges" from the facts it helped corroborate. Derived
    // here from `members` (mirroring buildSynthesisPrompt's contrast filter) since
    // the prompt's local `contrast` array is no longer in this scope.
    const contrastKeys = new Set(
      members
        .filter((m) => m.cls === 'attach' || (m.cls === 'anchor-only' && m.label === 'contrast'))
        .map((m) => m.key),
    );
    const cleanList = (v: unknown): string[] =>
      Array.isArray(v)
        ? v
            .filter((x): x is string => typeof x === 'string')
            .map((x) => x.trim())
            .filter(Boolean)
            .slice(0, 3)
        : [];
    const alignments: Record<string, { align: string[]; diverge: string[]; pct: number }> = {};
    if (parsed.alignments && typeof parsed.alignments === 'object') {
      for (const [k, v] of Object.entries(parsed.alignments as Record<string, unknown>)) {
        if (!contrastKeys.has(k) || !v || typeof v !== 'object') continue;
        const obj = v as { align?: unknown; diverge?: unknown; pct?: unknown };
        const align = cleanList(obj.align);
        const diverge = cleanList(obj.diverge);
        const hasPct = typeof obj.pct === 'number' && Number.isFinite(obj.pct);
        // Keep an entry when the model gave specific bullets OR a holistic pct.
        // A pct-only entry (no itemized bullets) is real signal for an adversary
        // source the model rated without listing specifics; dropping it would
        // discard a genuine alignment score and leave the row looking unanalyzed.
        if (!align.length && !diverge.length && !hasPct) continue;
        // Prefer the model's holistic 0-100 alignment estimate; fall back to a
        // bullet-count ratio so a stored entry ALWAYS carries a pct (otherwise the
        // re-synth-once trigger that fills missing pct would loop forever). When
        // hasPct is false we only reach here with at least one bullet, so total>0.
        const total = align.length + diverge.length;
        const rawPct = hasPct
          ? Math.round(obj.pct as number)
          : Math.round((align.length / total) * 100);
        const pct = Math.max(0, Math.min(100, rawPct));
        alignments[k] = { align, diverge, pct };
      }
    }

    // Cap at 4 claims but never hard-slice a claim to a fixed word count — that
    // truncated attributed statements mid-sentence in the curated detail view.
    // The prompt already keeps each claim to ~25 words.
    // Near-duplicate deduplication mirrors the per-article enrichment path:
    // removes same-assertion rewordings and same-predicate subject-splits.
    // (Same filter chain as before Task #1100 — the loop only ADDS a counter for
    // meta-filler drops; kept claims, order, dedup, and cap are unchanged.)
    const rawClaimLines = Array.isArray(parsed.attributedClaims)
      ? parsed.attributedClaims
          .filter((c): c is string => typeof c === 'string')
          .map((c) => c.trim())
          .filter(Boolean)
      : [];
    const keptClaimLines: string[] = [];
    for (const c of rawClaimLines) {
      if (isMetaFillerLine(c)) junkLinesDropped++;
      else keptClaimLines.push(c);
    }
    const attributedClaims = deduplicateLines(
      filterExplicitlyAttributedClaims(keptClaimLines),
    ).slice(0, 4);
    // Junk/meta-filler telemetry (Task #1100) — count only, output unchanged.
    if (junkLinesDropped > 0) recordCuratedSynthJunkLines(junkLinesDropped);

    // Collect non-generated source text for person/title grounding. Summaries
    // and bullets are excluded because they are AI output and may already carry
    // the exact stale-model substitution this boundary is meant to reject.
    const memberSourceTexts = buildSynthesisGroundingSourceTexts(members);

    // FALSE-MERGE backstop (Task #362). Build each kept fact's CORROBORATING
    // support set from the model's factSources (aligned to the original fact
    // index), restricted to corroborating keys, then run the pure structural
    // check. corroborated=false ONLY for the clear single-sourced-everywhere tell.
    const corroboratingKeys = new Set(corroborating.map((m) => m.key));
    const factSourcesRaw = parsed.factSources;
    const supportFor = (origIdx: number): string[] => {
      let arr: unknown;
      if (Array.isArray(factSourcesRaw)) {
        arr = factSourcesRaw[origIdx];
      } else if (factSourcesRaw && typeof factSourcesRaw === 'object') {
        const obj = factSourcesRaw as Record<string, unknown>;
        arr = obj[String(origIdx + 1)] ?? obj[String(origIdx)];
      }
      return Array.isArray(arr)
        ? Array.from(
            new Set(
              arr.filter(
                (k): k is string => typeof k === 'string' && corroboratingKeys.has(k),
              ),
            ),
          )
        : [];
    };
    const factSupport: FactSupport[] = keptFacts.map((e) => ({
      fact: e.fact,
      sourceKeys: supportFor(e.idx),
    }));
    const ownerByKey = new Map<string, string[]>();
    const sourceByKey = new Map<string, string>();
    for (const m of members) {
      ownerByKey.set(m.key, m.ownership ?? []);
      sourceByKey.set(m.key, m.source);
    }
    const corroborated = !isLikelyFalseMerge(factSupport, ownerByKey, sourceByKey);

    // Write-time stale-status sanitization. Strip AI-injected status descriptors
    // ("Former President Trump") that the source members never apply to that person.
    const cleanHeadline = groundGeneratedTextInSources(headline, memberSourceTexts) ?? '';
    const cleanLede = groundGeneratedTextInSources(lede, memberSourceTexts) ?? '';
    const cleanFacts = groundGeneratedLinesInSources(facts, memberSourceTexts);
    const safeDisplay = salvageSynthesisHeadlineAndLede({
      headline: cleanHeadline,
      lede: cleanLede,
      facts: cleanFacts,
    });
    if (safeDisplay.replacedHeadline || safeDisplay.replacedLede) {
      console.warn(
        `[CuratedSynthesis] Replaced unattributed source-dependent ${[
          safeDisplay.replacedHeadline ? 'headline' : '',
          safeDisplay.replacedLede ? 'lede' : '',
        ].filter(Boolean).join(' and ')} while preserving safe synthesis fields`,
      );
    }
    const groundedClaims = groundGeneratedLinesInSources(attributedClaims, memberSourceTexts);
    // Facts and claims are additive sections, not two phrasings of the same
    // proposition. Keep the fact and discard a claim that merely repeats it with
    // an attribution wrapper ("The Pentagon said ...").
    const cleanClaims = excludeNearDuplicateLines(
      filterExplicitlyAttributedClaims(groundedClaims),
      cleanFacts,
    );

    // Sanitize spins (one string per member key) — same source oracle.
    const cleanSpins: Record<string, string> = {};
    for (const [k, v] of Object.entries(spins)) {
      const grounded = groundGeneratedTextInSources(v, memberSourceTexts);
      if (grounded) cleanSpins[k] = grounded;
    }

    // Sanitize alignment align/diverge phrase arrays — same source oracle.
    // The `pct` number is never altered.
    const cleanAlignments: Record<string, { align: string[]; diverge: string[]; pct: number }> = {};
    for (const [k, entry] of Object.entries(alignments)) {
      cleanAlignments[k] = {
        align: groundGeneratedLinesInSources(entry.align, memberSourceTexts),
        diverge: groundGeneratedLinesInSources(entry.diverge, memberSourceTexts),
        pct: entry.pct,
      };
    }

    // WRONG-SHAPE fail-safe: a reply that is valid JSON but carries
    // NONE of the synthesis fields (headline/lede/facts all empty after
    // validation) is garbage — schema drift or the model echoing an unrelated
    // object. Persisting it would blank a formed story's card. Treat it exactly
    // like an unparseable reply: skip this story for the pass, retry next pass.
    if (!safeDisplay.headline && !safeDisplay.lede && cleanFacts.length === 0) {
      console.warn(`[CuratedSynthesis] MALFORMED AI response (valid JSON but no headline/lede/facts) — story not synthesized this pass (cluster preserved, retries next pass) :: ${aiResponseSnippet(content)}`);
      recordCuratedSynthSkipRetry(); // telemetry only (Task #1100)
      return null;
    }

    return {
      headline: safeDisplay.headline,
      lede: safeDisplay.lede,
      facts: cleanFacts,
      spins: cleanSpins,
      alignments: cleanAlignments,
      attributedClaims: cleanClaims,
      corroborated,
    };
  } catch (error) {
    // API/network/timeout failure (thrown by the create() call above), distinct
    // from the inline malformed-payload markers. Fail-safe: return null so the
    // caller keeps the cluster and just skips synthesis this pass — no member is
    // dropped, it retries next pass.
    console.error('[CuratedSynthesis] API/network error synthesizing story (cluster preserved, retries next pass):', error);
    recordCuratedSynthSkipRetry(); // telemetry only (Task #1100)
    return null;
  }
}
