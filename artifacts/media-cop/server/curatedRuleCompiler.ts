// Curated lane — editor-feedback LEARNING LOOP (Task #659). Deterministic,
// no-LLM compiler that mines the raw `curated_override_events` log (+
// `curated_manual_links`) into a small set of OVERARCHING candidate rules of
// exactly 5 kinds. It only ever writes 'suggested' rows (via
// storage.upsertSuggestedCuratedLearnedRule) — a human must Approve in the
// Source Oversight "Adjustments" tab before a rule takes effect (see
// server/curatedLearnedRulesCache.ts + the enforcement call sites). Never
// touches Classic/Visual/custom-MCOP/public API or main-feed scoring. Runs on
// a schedule (see server/scheduler.ts) and is safe to re-run at any time —
// every write is either a fresh 'suggested' insert or a refresh-in-place of an
// existing still-'suggested'/cooled-down-'snoozed' row for the same signature.
import { storage } from './storage';
import type { CuratedOverrideEvent, InsertCuratedLearnedRule } from '@shared/schema';
import { CURATED_SOFT_CAP, resolveLearnedRuleCompilerSince } from './scoreAdjustments';
import { normalizeOutletName } from '@shared/outletRegistry';
import { normalizeIdentityUrl } from './urlIdentity';

// Score at/above which the AI's original score is considered "high" — the same
// threshold the override report uses to flag AI-vs-editor scoring conflicts.
const SCORE_THRESHOLD = 50;
// Ceiling a learned scoring cap pulls an over-scored outlet×category back to.
// Reuses the deterministic soft-politics low band so an approved scoring cap
// behaves exactly like the existing curated caps (DOWN-only, CAP-only).
const SCORING_CAP_CEILING = CURATED_SOFT_CAP;

// priority-override newValue is written as "pinned to <score>" at capture time.
function parsePinnedScore(newValue: string | null | undefined): number | null {
  if (!newValue) return null;
  const m = /pinned to (\d+)/.exec(newValue);
  return m ? parseInt(m[1], 10) : null;
}

// Minimum raw event count before a pattern is worth suggesting at all — keeps
// the approval queue to genuinely "overarching" patterns, not one-off corrections.
const MIN_EVIDENCE = 3;
// Minimum number of DISTINCT stories that must be involved for a correction
// pattern to reach the suggestion queue. A pattern with ≥3 events all on the
// SAME story (e.g. one headline corrected 3 times by different editors) is NOT
// an overarching standing pattern — it is a disagreement on a single item.
// Such patterns are held back from the suggestion queue and shown in the
// sub-threshold telemetry preview with a "same story" annotation instead.
const MIN_DISTINCT_STORIES = 2;
// How far back the compiler looks each run. Wide enough to catch slow-burn
// patterns without unbounded growth (event table is append-only).
const LOOKBACK_DAYS = 90;
const MAX_EVENTS = 5000;
const MAX_EVIDENCE_SAMPLES = 5;

// ---------------------------------------------------------------------------
// Story identity helpers. Two events are "about the same story" when they
// share the same normalized item URL, the same storyKey (cluster/item
// reference), or (as a last resort) the same lowercased headline text.
// URL-identity is preferred because the same headline can get minor headline
// changes across correction events (editors rename as they correct), while a
// URL stays stable.
// ---------------------------------------------------------------------------
function storyIdentityKey(e: CuratedOverrideEvent): string | null {
  // 1. Prefer itemUrl — most stable identity across time
  const url = normalizeIdentityUrl(e.itemUrl);
  if (url) {
    // Shared Curated identity removes only tracking attribution. In particular,
    // preserve `id`/`p` style query parameters: deleting all query parameters
    // would make distinct stories on query-routed publishers one false story.
    return `url:${url}`;
  }
  // 2. storyKey (cluster:<id> | main:<id> | curated:<id>) — server-side stable
  const sk = e.storyKey?.trim();
  if (sk) return `key:${sk}`;
  // 3. Normalized headline — last resort (headline edits can differ across events)
  const hl = e.headline?.trim();
  if (hl) return `title:${hl.toLowerCase()}`;
  return null;
}

function countDistinctStories(events: CuratedOverrideEvent[]): number {
  const seen = new Set<string>();
  for (const e of events) {
    const k = storyIdentityKey(e);
    if (k) seen.add(k);
  }
  // Treat events with no identity (rare/legacy rows) each as their own story so
  // they don't collapse into zero when combined with identified events.
  const nullCount = events.filter(e => storyIdentityKey(e) === null).length;
  return seen.size + nullCount;
}

// Confidence keys off distinct-story count, not raw event count, so a single
// story corrected many times cannot inflate confidence.
function confidenceFor(distinctStoryCount: number): 'high' | 'medium' | 'low' {
  if (distinctStoryCount >= 5) return 'high';
  if (distinctStoryCount >= 3) return 'medium';
  return 'low';
}

// Deduplicated evidence sample — avoids showing the same headline 3 times when
// a single story was corrected repeatedly.
function dedupedSampleOf(events: CuratedOverrideEvent[]): Record<string, unknown>[] {
  const seenStories = new Set<string>();
  const result: Record<string, unknown>[] = [];
  for (const e of events) {
    if (result.length >= MAX_EVIDENCE_SAMPLES) break;
    const storyKey = storyIdentityKey(e) ?? `event:${e.id}`;
    if (seenStories.has(storyKey)) continue;
    seenStories.add(storyKey);
    result.push({
      headline: e.headline ?? null,
      outlet: e.outlet ?? null,
      action: e.action,
      newValue: e.newValue ?? null,
      createdAt: e.createdAt,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Impact preview (Task #887, corpus-based). How many curated ITEMS in the
// lookback window match the rule's outlet×category (and, for scoring-cap, its
// score semantics) — i.e. the real retrospective blast radius the rule WOULD
// have had, computed over the full curated_items corpus. NOT computed from the
// override events: events only cover items an editor happened to touch, which
// substantially undercounts real scope (most affected items are never
// corrected). Stored in the rule payload so the approval card can show scope
// without a live DB query. `basis: 'item-corpus'` marks the new semantics so
// consumers can distinguish refreshed payloads from any legacy event-based ones.
// ---------------------------------------------------------------------------
export interface ImpactCorpusItem {
  url: string;
  title: string;
  source: string;
  category: string;
  priorityScore: number | null;
}

interface ImpactPreview {
  // Number of curated items in the corpus window this rule would have affected.
  affectedCount: number;
  // Number of distinct stories (by normalized URL, title fallback) among them.
  distinctStoryCount: number;
  // Days of curated item history the corpus covers.
  windowDays: number;
  // Semantics marker: 'item-corpus' = counted over the full curated item
  // corpus (scoring-cap / irrelevance-suppression). 'override-events' =
  // counted over the raw editor-action log (outlet-behavior-flip /
  // classification-relabel — there is no deterministic corpus predicate for
  // "would have been flipped/relabeled", so the honest retrospective measure
  // is how often editors actually made that correction). 'manual-links' =
  // counted over the active manual-link table (must-link).
  basis: 'item-corpus' | 'override-events' | 'manual-links';
}

// Events-based retrospective impact for the rule types whose blast radius
// cannot be computed from the item corpus (see basis docs above).
function computeEventImpact(events: CuratedOverrideEvent[]): ImpactPreview {
  return {
    affectedCount: events.length,
    distinctStoryCount: countDistinctStories(events),
    windowDays: LOOKBACK_DAYS,
    basis: 'override-events',
  };
}

function corpusStoryKey(item: ImpactCorpusItem): string {
  const url = item.url?.trim();
  if (url) {
    try {
      const u = new URL(url.toLowerCase());
      return `url:${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      return `url:${url.toLowerCase()}`;
    }
  }
  return `title:${(item.title ?? '').trim().toLowerCase()}`;
}

function matchKey(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

function outletMatchKey(s: string | null | undefined): string {
  return normalizeOutletName(s);
}

export function computeScoringCapImpactFromCorpus(
  corpus: ImpactCorpusItem[],
  outlet: string,
  category: string,
  cap: number,
): ImpactPreview {
  const o = outletMatchKey(outlet);
  const c = matchKey(category);
  // A scoring cap only bites on items whose stored (raw) score is ABOVE the cap.
  const relevant = corpus.filter(item =>
    outletMatchKey(item.source) === o &&
    matchKey(item.category) === c &&
    item.priorityScore != null && item.priorityScore > cap,
  );
  const stories = new Set(relevant.map(corpusStoryKey));
  return { affectedCount: relevant.length, distinctStoryCount: stories.size, windowDays: LOOKBACK_DAYS, basis: 'item-corpus' };
}

export function computeSuppressionImpactFromCorpus(
  corpus: ImpactCorpusItem[],
  outlet: string,
  category: string,
): ImpactPreview {
  const o = outletMatchKey(outlet);
  const c = matchKey(category);
  // Suppression removes EVERY matching outlet×category item, regardless of score.
  const relevant = corpus.filter(item =>
    outletMatchKey(item.source) === o && matchKey(item.category) === c,
  );
  const stories = new Set(relevant.map(corpusStoryKey));
  return { affectedCount: relevant.length, distinctStoryCount: stories.size, windowDays: LOOKBACK_DAYS, basis: 'item-corpus' };
}

// classification newValue format written at capture time:
// "re-labeled to <topic> · <track> · <region> · <country>" (empty segments
// filtered, so the first non-empty segment is always the new topic).
function extractRelabeledTopic(newValue: string | null | undefined): string | null {
  if (!newValue) return null;
  const m = /^re-labeled to\s+([^·]+)/i.exec(newValue.trim());
  if (!m) return null;
  const topic = m[1].trim();
  return topic.length > 0 ? topic : null;
}

const HIDE_ACTIONS = new Set(['hide-story', 'manual-unlink']);
const UNHIDE_ACTIONS = new Set(['unhide-story']);

// ---------------------------------------------------------------------------
// Rule 1: outlet behavior-class flip. Repeated hides/unlinks of an outlet's
// items suggest flipping it to attach-only; repeated un-hides suggest the
// reverse (corroborating). Overarching (outlet-level, not content-specific).
// Distinct-story requirement applies: the same item hidden/unhidden Nx counts
// as 1 distinct story, so a pattern of editors hiding/unhiding the SAME article
// repeatedly (one item disagreement) cannot reach the suggest queue.
// ---------------------------------------------------------------------------
function groupOutletHideUnhide(events: CuratedOverrideEvent[]): {
  hidesByOutlet: Map<string, CuratedOverrideEvent[]>;
  unhidesByOutlet: Map<string, CuratedOverrideEvent[]>;
} {
  const hidesByOutlet = new Map<string, CuratedOverrideEvent[]>();
  const unhidesByOutlet = new Map<string, CuratedOverrideEvent[]>();
  for (const e of events) {
    const outlet = normalizeOutletName(e.outlet);
    if (!outlet) continue;
    if (HIDE_ACTIONS.has(e.action)) {
      const arr = hidesByOutlet.get(outlet) ?? [];
      arr.push(e);
      hidesByOutlet.set(outlet, arr);
    } else if (UNHIDE_ACTIONS.has(e.action)) {
      const arr = unhidesByOutlet.get(outlet) ?? [];
      arr.push(e);
      unhidesByOutlet.set(outlet, arr);
    }
  }
  return { hidesByOutlet, unhidesByOutlet };
}

function compileOutletBehaviorFlips(events: CuratedOverrideEvent[]): InsertCuratedLearnedRule[] {
  const { hidesByOutlet, unhidesByOutlet } = groupOutletHideUnhide(events);
  const rules: InsertCuratedLearnedRule[] = [];
  for (const [outlet, hideEvents] of Array.from(hidesByOutlet.entries())) {
    if (hideEvents.length < MIN_EVIDENCE) continue;
    const distinctStories = countDistinctStories(hideEvents);
    if (distinctStories < MIN_DISTINCT_STORIES) continue;
    const unhideCount = unhidesByOutlet.get(outlet)?.length ?? 0;
    if (unhideCount >= hideEvents.length) continue;
    rules.push({
      ruleType: 'outlet-behavior-flip',
      signature: `outlet-behavior-flip:${outlet}:attach`,
      label: `Flip "${outlet}" to attach-only — editors repeatedly hid/unlinked its items (${hideEvents.length}x across ${distinctStories} stories)`,
      payload: { outlet, direction: 'attach', distinctStoryCount: distinctStories, impactPreview: computeEventImpact(hideEvents) },
      evidenceCount: hideEvents.length,
      evidenceSamples: dedupedSampleOf(hideEvents),
      confidence: confidenceFor(distinctStories),
      status: 'suggested',
    });
  }
  for (const [outlet, unhideEvents] of Array.from(unhidesByOutlet.entries())) {
    if (unhideEvents.length < MIN_EVIDENCE) continue;
    const distinctStories = countDistinctStories(unhideEvents);
    if (distinctStories < MIN_DISTINCT_STORIES) continue;
    const hideCount = hidesByOutlet.get(outlet)?.length ?? 0;
    if (hideCount >= unhideEvents.length) continue;
    rules.push({
      ruleType: 'outlet-behavior-flip',
      signature: `outlet-behavior-flip:${outlet}:corroborating`,
      label: `Flip "${outlet}" to corroborating — editors repeatedly restored/un-hid its items (${unhideEvents.length}x across ${distinctStories} stories)`,
      payload: { outlet, direction: 'corroborating', distinctStoryCount: distinctStories, impactPreview: computeEventImpact(unhideEvents) },
      evidenceCount: unhideEvents.length,
      evidenceSamples: dedupedSampleOf(unhideEvents),
      confidence: confidenceFor(distinctStories),
      status: 'suggested',
    });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Rule 2: standing classification relabel. An outlet whose Topic/Category is
// repeatedly corrected FROM the same origin TO the same target suggests a
// standing outlet+fromTopic -> toTopic mapping.
// ---------------------------------------------------------------------------
function groupClassificationRelabels(events: CuratedOverrideEvent[]): Map<string, CuratedOverrideEvent[]> {
  const byKey = new Map<string, CuratedOverrideEvent[]>();
  for (const e of events) {
    if (e.action !== 'classification') continue;
    const outlet = normalizeOutletName(e.outlet);
    const fromTopic = e.originalTopic?.trim();
    const toTopic = extractRelabeledTopic(e.newValue);
    if (!outlet || !fromTopic || !toTopic || fromTopic === toTopic) continue;
    const key = `${outlet}::${fromTopic}::${toTopic}`;
    const arr = byKey.get(key) ?? [];
    arr.push(e);
    byKey.set(key, arr);
  }
  return byKey;
}

function compileClassificationRelabels(events: CuratedOverrideEvent[]): InsertCuratedLearnedRule[] {
  const byKey = groupClassificationRelabels(events);
  // Impact scope = ALL classification events for the outlet × fromTopic in the
  // window (any target topic) — the full set of items editors had to correct
  // away from that origin label, which the standing relabel would have handled.
  const byOutletFrom = new Map<string, CuratedOverrideEvent[]>();
  for (const [key, evs] of Array.from(byKey.entries())) {
    const [outlet, fromTopic] = key.split('::');
    const ofKey = `${outlet}::${fromTopic}`;
    byOutletFrom.set(ofKey, (byOutletFrom.get(ofKey) ?? []).concat(evs));
  }
  const rules: InsertCuratedLearnedRule[] = [];
  for (const [key, evs] of Array.from(byKey.entries())) {
    if (evs.length < MIN_EVIDENCE) continue;
    const distinctStories = countDistinctStories(evs);
    if (distinctStories < MIN_DISTINCT_STORIES) continue;
    const [outlet, fromTopic, toTopic] = key.split('::');
    const impact = computeEventImpact(byOutletFrom.get(`${outlet}::${fromTopic}`) ?? evs);
    rules.push({
      ruleType: 'classification-relabel',
      signature: `classification-relabel:${outlet}:${fromTopic}:${toTopic}`,
      label: `Standing relabel: "${outlet}" items tagged "${fromTopic}" -> "${toTopic}" (${evs.length}x across ${distinctStories} stories)`,
      payload: { outlet, fromTopic, toTopic, distinctStoryCount: distinctStories, impactPreview: impact },
      evidenceCount: evs.length,
      evidenceSamples: dedupedSampleOf(evs),
      confidence: confidenceFor(distinctStories),
      status: 'suggested',
    });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Rule 3: standing must-link. The same outlet PAIR manually linked repeatedly
// suggests a standing grouping bias between those two sources. Resolves each
// manual link's member URLs to their outlet via curated_items.source (fails
// open on lookup errors — a link simply doesn't contribute evidence).
// Must-links come from a separate table (not override events), so the distinct-
// story requirement doesn't apply in the same way — each manual link is already
// one linking action on a separate pair of items.
// ---------------------------------------------------------------------------
async function compileMustLinks(): Promise<InsertCuratedLearnedRule[]> {
  let links: Awaited<ReturnType<typeof storage.getActiveCuratedManualLinks>> = [];
  try {
    links = await storage.getActiveCuratedManualLinks();
  } catch (e) {
    console.warn('[CuratedRuleCompiler] Could not load manual links (must-link mining skipped):', e);
    return [];
  }
  const byPair = new Map<string, { count: number; samples: Record<string, unknown>[] }>();
  for (const link of links) {
    const urls = link.memberUrls ?? [];
    if (urls.length < 2) continue;
    const outlets = new Set<string>();
    for (const url of urls) {
      try {
        const item = await storage.getCuratedItemByUrl(url);
        const source = normalizeOutletName(item?.source);
        if (source) outlets.add(source);
      } catch {
        // Fail open — this URL just doesn't contribute an outlet.
      }
    }
    if (outlets.size !== 2) continue; // overarching = exactly a cross-outlet pair
    const [a, b] = Array.from(outlets).sort();
    const key = `${a}::${b}`;
    const entry = byPair.get(key) ?? { count: 0, samples: [] };
    entry.count += 1;
    if (entry.samples.length < MAX_EVIDENCE_SAMPLES) {
      entry.samples.push({ label: link.label ?? null, kind: link.kind, createdAt: link.createdAt });
    }
    byPair.set(key, entry);
  }
  const rules: InsertCuratedLearnedRule[] = [];
  for (const [key, entry] of Array.from(byPair.entries())) {
    if (entry.count < MIN_EVIDENCE) continue;
    const [outletA, outletB] = key.split('::');
    rules.push({
      ruleType: 'must-link',
      signature: `must-link:${outletA}:${outletB}`,
      label: `Standing must-link: "${outletA}" <-> "${outletB}" manually linked repeatedly (${entry.count}x)`,
      payload: {
        outletA,
        outletB,
        // Each active manual link is one linking action on a distinct pair of
        // items, so affected = distinct-story = the link count.
        impactPreview: {
          affectedCount: entry.count,
          distinctStoryCount: entry.count,
          windowDays: LOOKBACK_DAYS,
          basis: 'manual-links',
        } satisfies ImpactPreview,
      },
      evidenceCount: entry.count,
      evidenceSamples: entry.samples,
      confidence: confidenceFor(entry.count),
      status: 'suggested',
    });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Rule 4: irrelevance suppression (the sole content-specific case). An
// outlet+category pattern editors repeatedly hide as irrelevant suggests
// suppressing that combination going forward.
// ---------------------------------------------------------------------------
function groupIrrelevanceSuppressions(events: CuratedOverrideEvent[]): Map<string, CuratedOverrideEvent[]> {
  const byKey = new Map<string, CuratedOverrideEvent[]>();
  for (const e of events) {
    if (e.action !== 'hide-story') continue;
    const outlet = normalizeOutletName(e.outlet);
    const category = e.originalCategory?.trim();
    if (!outlet || !category) continue;
    const key = `${outlet}::${category}`;
    const arr = byKey.get(key) ?? [];
    arr.push(e);
    byKey.set(key, arr);
  }
  return byKey;
}

export function compileIrrelevanceSuppressions(
  events: CuratedOverrideEvent[],
  corpus: ImpactCorpusItem[] | null = null,
): InsertCuratedLearnedRule[] {
  const byKey = groupIrrelevanceSuppressions(events);
  const rules: InsertCuratedLearnedRule[] = [];
  for (const [key, evs] of Array.from(byKey.entries())) {
    if (evs.length < MIN_EVIDENCE) continue;
    const distinctStories = countDistinctStories(evs);
    if (distinctStories < MIN_DISTINCT_STORIES) continue;
    const [outlet, category] = key.split('::');
    // Corpus-based blast radius (null when the corpus load failed — the card
    // then shows "impact unavailable" rather than a misleading number).
    const impact = corpus ? computeSuppressionImpactFromCorpus(corpus, outlet, category) : null;
    rules.push({
      ruleType: 'irrelevance-suppression',
      signature: `irrelevance-suppression:${outlet}:${category}`,
      label: `Suppress "${outlet}" × "${category}" — repeatedly hidden as irrelevant (${evs.length}x across ${distinctStories} stories)`,
      payload: { outlet, category, distinctStoryCount: distinctStories, impactPreview: impact },
      evidenceCount: evs.length,
      evidenceSamples: dedupedSampleOf(evs),
      confidence: confidenceFor(distinctStories),
      status: 'suggested',
    });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Rule 5: SCORING/RELEVANCE cap (Task #678 — DOWN-only, cap-only). An
// outlet+category the editors repeatedly REMOVE despite a HIGH AI score
// (hide-story with a high originalScore) OR repeatedly pin DOWN below the AI's
// score (priority-override with pinned < originalScore) is a standing
// AI-over-scoring pattern. Once approved this becomes a deterministic curated
// cap that pulls that class back into the low band on the next pass through the
// existing cap mechanism (server/scoreAdjustments.ts + curatedIngest.ts). It is
// STRICTLY a cap: it can only ever LOWER an AI/machine score, never raise one,
// and never touches a real human/upstream score. Curated-lane ONLY.
// ---------------------------------------------------------------------------
function groupScoringCapSignals(events: CuratedOverrideEvent[]): Map<string, CuratedOverrideEvent[]> {
  const byKey = new Map<string, CuratedOverrideEvent[]>();
  for (const e of events) {
    const outlet = normalizeOutletName(e.outlet);
    const category = e.originalCategory?.trim();
    if (!outlet || !category) continue;
    let isDownSignal = false;
    if (e.action === 'hide-story') {
      // Editor removed an item the AI scored HIGH → AI over-scored this class.
      if (e.originalScore != null && e.originalScore >= SCORE_THRESHOLD) isDownSignal = true;
    } else if (e.action === 'priority-override') {
      // Editor pinned the item DOWN, below the AI's own original score.
      const pinned = parsePinnedScore(e.newValue);
      if (pinned != null && e.originalScore != null && pinned < e.originalScore) {
        isDownSignal = true;
      }
    }
    if (!isDownSignal) continue;
    const key = `${outlet}::${category}`;
    const arr = byKey.get(key) ?? [];
    arr.push(e);
    byKey.set(key, arr);
  }
  return byKey;
}

export function compileScoringCaps(
  events: CuratedOverrideEvent[],
  corpus: ImpactCorpusItem[] | null = null,
): InsertCuratedLearnedRule[] {
  const byKey = groupScoringCapSignals(events);
  const rules: InsertCuratedLearnedRule[] = [];
  for (const [key, evs] of Array.from(byKey.entries())) {
    if (evs.length < MIN_EVIDENCE) continue;
    const distinctStories = countDistinctStories(evs);
    if (distinctStories < MIN_DISTINCT_STORIES) continue;
    const [outlet, category] = key.split('::');
    // Corpus-based blast radius (null when the corpus load failed — the card
    // then shows "impact unavailable" rather than a misleading number).
    const impact = corpus ? computeScoringCapImpactFromCorpus(corpus, outlet, category, SCORING_CAP_CEILING) : null;
    rules.push({
      ruleType: 'scoring-cap',
      signature: `scoring-cap:${outlet}:${category}`,
      label: `Cap "${outlet}" × "${category}" to \u2264${SCORING_CAP_CEILING} — editors repeatedly hid or down-pinned the AI's high score (${evs.length}x across ${distinctStories} stories)`,
      payload: { outlet, category, cap: SCORING_CAP_CEILING, distinctStoryCount: distinctStories, impactPreview: impact },
      evidenceCount: evs.length,
      evidenceSamples: dedupedSampleOf(evs),
      confidence: confidenceFor(distinctStories),
      status: 'suggested',
    });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Rule 6: SCORING/RELEVANCE boost (Task #834 — UP-only, suggest-only). An
// outlet+category the editors repeatedly PIN UP above a LOW AI score signals
// a standing AI-under-scoring pattern. Evidence = 'priority-override' events
// where `pinned > originalScore` and `originalScore < SCORE_THRESHOLD`.
// Once suggested, a human can Approve the rule to serve as advisory context
// for source-weight or scoring-baseline tuning. Unlike scoring-cap there is
// no enforcement mechanism today — this is a pattern-detection signal only.
// Curated-lane ONLY (fail-closed, never touches main-feed scoring).
// ---------------------------------------------------------------------------
function groupUnderScoringSignals(events: CuratedOverrideEvent[]): Map<string, CuratedOverrideEvent[]> {
  const byKey = new Map<string, CuratedOverrideEvent[]>();
  for (const e of events) {
    if (e.action !== 'priority-override') continue;
    const outlet = normalizeOutletName(e.outlet);
    const category = e.originalCategory?.trim();
    if (!outlet || !category) continue;
    const pinned = parsePinnedScore(e.newValue);
    if (pinned == null || e.originalScore == null) continue;
    // UP-pin where the AI's original score was LOW — editor consistently
    // promotes a class the AI consistently under-values.
    if (pinned > e.originalScore && e.originalScore < SCORE_THRESHOLD) {
      const key = `${outlet}::${category}`;
      const arr = byKey.get(key) ?? [];
      arr.push(e);
      byKey.set(key, arr);
    }
  }
  return byKey;
}

function compileUnderScoringBoosts(events: CuratedOverrideEvent[]): InsertCuratedLearnedRule[] {
  const byKey = groupUnderScoringSignals(events);
  const rules: InsertCuratedLearnedRule[] = [];
  for (const [key, evs] of Array.from(byKey.entries())) {
    if (evs.length < MIN_EVIDENCE) continue;
    const distinctStories = countDistinctStories(evs);
    if (distinctStories < MIN_DISTINCT_STORIES) continue;
    const [outlet, category] = key.split('::');
    const avgPinned = Math.round(
      evs.reduce((s, e) => s + (parsePinnedScore(e.newValue) ?? 0), 0) / evs.length,
    );
    rules.push({
      ruleType: 'scoring-boost',
      signature: `scoring-boost:${outlet}:${category}`,
      label: `Boost "${outlet}" \u00d7 "${category}" — editors repeatedly up-pinned (avg\u2192${avgPinned}) despite low AI score (${evs.length}x across ${distinctStories} stories)`,
      // This is intentionally NOT an enforceable score change. Approval records
      // a reviewable tuning recommendation only; it cannot affect machine scores,
      // relevance rejection, classification overlays, or human pins.
      payload: {
        outlet,
        category,
        avgPinnedScore: avgPinned,
        distinctStoryCount: distinctStories,
        advisoryOnly: true,
        enforcement: 'none',
        impactPreview: computeEventImpact(evs),
      },
      evidenceCount: evs.length,
      evidenceSamples: dedupedSampleOf(evs),
      confidence: confidenceFor(distinctStories),
      status: 'suggested',
    });
  }
  return rules;
}

export interface CompileResult {
  scanned: number;
  suggested: number;
  byType: Record<string, number>;
}

// Entry point — reads the raw log, aggregates all 5 rule types, and
// upserts each as a 'suggested' row (deduped by signature; never resurfaces
// a rejected/still-cooling-down-snoozed rule — that gating lives in
// storage.upsertSuggestedCuratedLearnedRule). Fail-open per rule-type: an
// error in one type never blocks the others.
export async function runCuratedRuleCompiler(): Promise<CompileResult> {
  const lookbackSince = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  // Honor the Adjustments "Reset" checkpoint (curated_feedback_settings.acknowledgedAt):
  // a reset must truly start a fresh learning cycle, so never mine editor actions
  // logged before it. Take the LATER of the plain lookback window and the reset
  // checkpoint. Fail-open to the plain lookback if the settings read fails.
  let since = lookbackSince;
  try {
    const settings = await storage.getCuratedFeedbackSettings();
    since = resolveLearnedRuleCompilerSince(lookbackSince, settings.acknowledgedAt);
  } catch (e) {
    console.error('[CuratedRuleCompiler] Failed to load feedback settings (using plain lookback window):', e);
  }
  let events: CuratedOverrideEvent[] = [];
  try {
    events = await storage.getCuratedOverrideEventsSince(since, MAX_EVENTS);
  } catch (e) {
    console.error('[CuratedRuleCompiler] Failed to load override events (aborting this pass):', e);
    return { scanned: 0, suggested: 0, byType: {} };
  }

  // Load the FULL curated item corpus for the plain lookback window so the
  // scoring-cap / irrelevance-suppression rules can carry a real retrospective
  // impact preview (all matching items, not just corrected ones). The reset
  // checkpoint intentionally does NOT shrink this window — impact is about the
  // item corpus, not about which editor actions are minable. Fail-open: on a
  // load error the rules are still suggested, just without an impact preview.
  let corpus: ImpactCorpusItem[] | null = null;
  try {
    corpus = await storage.getCuratedItemsForImpactPreview(LOOKBACK_DAYS * 24);
  } catch (e) {
    console.error('[CuratedRuleCompiler] Failed to load curated item corpus (impact previews omitted this pass):', e);
  }

  const byType: Record<string, number> = {};
  let suggested = 0;

  const runners: Array<() => Promise<InsertCuratedLearnedRule[]> | InsertCuratedLearnedRule[]> = [
    () => compileOutletBehaviorFlips(events),
    () => compileClassificationRelabels(events),
    () => compileMustLinks(),
    () => compileIrrelevanceSuppressions(events, corpus),
    () => compileScoringCaps(events, corpus),
    () => compileUnderScoringBoosts(events),
  ];

  for (const run of runners) {
    let rules: InsertCuratedLearnedRule[] = [];
    try {
      rules = await run();
    } catch (e) {
      console.error('[CuratedRuleCompiler] A rule-type miner failed (continuing with the rest):', e);
      continue;
    }
    for (const rule of rules) {
      try {
        await storage.upsertSuggestedCuratedLearnedRule(rule);
        suggested++;
        byType[rule.ruleType] = (byType[rule.ruleType] ?? 0) + 1;
      } catch (e) {
        console.error(`[CuratedRuleCompiler] Failed to upsert suggested rule (${rule.signature}):`, e);
      }
    }
  }

  console.log(
    `[CuratedRuleCompiler] Scanned ${events.length} override events -> ${suggested} suggested rule(s) ` +
      `(${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'})`,
  );
  return { scanned: events.length, suggested, byType };
}

// ===========================================================================
// OBSERVE-ONLY correction telemetry (Task #806 follow-on). Same deterministic
// groupings the compiler uses, but WITHOUT the MIN_EVIDENCE gate — so the
// Adjustments tab can show where editors keep spending effort BEFORE a pattern
// crosses the suggest threshold. Read-only: this never writes a rule, never
// enforces anything, and shares the exact grouping helpers above so the
// candidate view can never drift from what the compiler will actually mine.
// Clustering (must-link) effort is intentionally omitted here — it needs a
// per-URL outlet resolution (expensive for a tab load) and is already surfaced
// as totals via the override-log report's clusteringChanges block.
//
// Single-story patterns (all corrections on the SAME story) are shown here
// even though they can never reach the suggestion queue, with a clear
// "same story corrected Nx" annotation so the signal is never silently lost.
// ===========================================================================
export interface CorrectionTelemetryCandidate {
  ruleType: InsertCuratedLearnedRule['ruleType'];
  // Human-readable descriptor of the outlet×category / relabel / outlet bucket.
  label: string;
  // How many matching editor corrections have accrued in the active window.
  count: number;
  // How many distinct stories are involved in the corrections.
  distinctStoryCount: number;
  // Set when all corrections were on the same story — explains why this bucket
  // won't reach the suggestion queue even after crossing the raw count threshold.
  singleStoryNote?: string;
  // Repeats still needed before this bucket becomes an approvable suggestion.
  // Accounts for both the raw count threshold AND the distinct-story requirement.
  remaining: number;
  // True once count has reached MIN_EVIDENCE AND distinctStoryCount has reached
  // MIN_DISTINCT_STORIES (i.e. it is now a real suggestion in the queue).
  atThreshold: boolean;
}
export interface CorrectionTelemetry {
  minEvidence: number;
  minDistinctStories: number;
  scannedEvents: number;
  candidates: CorrectionTelemetryCandidate[];
  // Reason-annotation breakdown across ALL events in the window — how often
  // editors cited each controlled-vocab reason key (an event citing two keys
  // counts once per key). Gives a concrete signal when a failure mode is
  // systemic, e.g. "12 of 15 manual links cited 'AI split this incorrectly'".
  reasonBreakdown: Record<string, number>;
  // How many events carried at least one reason annotation. The client hides
  // the breakdown below a small floor to avoid noise for low-volume editors.
  reasonAnnotatedEvents: number;
}

// Minimum repeats before a bucket is worth SHOWING as a candidate. A lone
// one-off correction on a unique outlet is noise, not "spending effort"; a
// bucket only becomes an early-warning candidate once it has repeated.
const TELEMETRY_MIN_DISPLAY = 2;

export function computeCuratedCorrectionTelemetry(events: CuratedOverrideEvent[]): CorrectionTelemetry {
  const candidates: CorrectionTelemetryCandidate[] = [];

  const push = (
    ruleType: InsertCuratedLearnedRule['ruleType'],
    label: string,
    count: number,
    distinctStoryCount: number,
  ) => {
    if (count < TELEMETRY_MIN_DISPLAY) return;
    // "At threshold" means BOTH the raw count AND distinct-story count have
    // been met — so a single-story pattern with 5 events is NOT at threshold.
    const atThreshold = count >= MIN_EVIDENCE && distinctStoryCount >= MIN_DISTINCT_STORIES;
    // How many MORE corrections are needed? The binding constraint is the one
    // farthest from its goal — whichever of the two gates still needs more.
    const remainingByCount = Math.max(0, MIN_EVIDENCE - count);
    // Distinct-story remaining: if already at ≥2 stories, 0; else more needed.
    // (We can't know exactly how many MORE events are needed to get a 2nd distinct
    // story if all events so far are on 1 story, but we signal "needs 2nd story".)
    const needsMoreStories = distinctStoryCount < MIN_DISTINCT_STORIES;
    const remaining = needsMoreStories ? Math.max(remainingByCount, 1) : remainingByCount;
    const singleStoryNote =
      distinctStoryCount === 1
        ? `all ${count} correction${count > 1 ? 's were' : ' was'} on the same story — needs corrections on ≥${MIN_DISTINCT_STORIES} distinct stories to suggest`
        : undefined;
    candidates.push({
      ruleType,
      label,
      count,
      distinctStoryCount,
      singleStoryNote,
      remaining,
      atThreshold,
    });
  };

  for (const [key, evs] of Array.from(groupScoringCapSignals(events).entries())) {
    const [outlet, category] = key.split('::');
    push('scoring-cap', `${outlet} × ${category} (over-scored)`, evs.length, countDistinctStories(evs));
  }
  for (const [key, evs] of Array.from(groupUnderScoringSignals(events).entries())) {
    const [outlet, category] = key.split('::');
    push('scoring-boost', `${outlet} × ${category} (under-scored, editors up-pinned)`, evs.length, countDistinctStories(evs));
  }
  for (const [key, evs] of Array.from(groupIrrelevanceSuppressions(events).entries())) {
    const [outlet, category] = key.split('::');
    push('irrelevance-suppression', `${outlet} × ${category} (hidden as irrelevant)`, evs.length, countDistinctStories(evs));
  }
  for (const [key, evs] of Array.from(groupClassificationRelabels(events).entries())) {
    const [outlet, fromTopic, toTopic] = key.split('::');
    push('classification-relabel', `${outlet}: ${fromTopic} → ${toTopic}`, evs.length, countDistinctStories(evs));
  }
  // Mirror the compiler's dual-direction outlet-behavior flip: preview both the
  // hide-dominant (→ attach-only) and unhide-dominant (→ corroborating) leads,
  // using the same dominance rule so the candidate view matches what the
  // compiler would actually suggest for this outlet.
  const { hidesByOutlet, unhidesByOutlet } = groupOutletHideUnhide(events);
  const behaviorOutlets = new Set<string>([
    ...Array.from(hidesByOutlet.keys()),
    ...Array.from(unhidesByOutlet.keys()),
  ]);
  for (const outlet of Array.from(behaviorOutlets)) {
    const hideEvs = hidesByOutlet.get(outlet) ?? [];
    const unhideEvs = unhidesByOutlet.get(outlet) ?? [];
    if (hideEvs.length > unhideEvs.length) {
      push('outlet-behavior-flip', `${outlet} (repeatedly hidden/unlinked → attach-only)`, hideEvs.length, countDistinctStories(hideEvs));
    } else if (unhideEvs.length > hideEvs.length) {
      push('outlet-behavior-flip', `${outlet} (repeatedly restored/un-hidden → corroborating)`, unhideEvs.length, countDistinctStories(unhideEvs));
    }
  }

  // Closest-to-threshold first (highest count), then alphabetically stable.
  candidates.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  // Reason-annotation breakdown: count each cited controlled-vocab key across
  // the window (an event citing multiple keys increments each once). Keys are
  // passed through raw; the client maps them to labels via the shared vocab.
  const reasonBreakdown: Record<string, number> = {};
  let reasonAnnotatedEvents = 0;
  for (const e of events) {
    const keys = e.reasonKeys;
    if (!Array.isArray(keys) || keys.length === 0) continue;
    reasonAnnotatedEvents++;
    for (const key of new Set(keys)) {
      if (typeof key !== 'string' || !key) continue;
      reasonBreakdown[key] = (reasonBreakdown[key] ?? 0) + 1;
    }
  }

  return {
    minEvidence: MIN_EVIDENCE,
    minDistinctStories: MIN_DISTINCT_STORIES,
    scannedEvents: events.length,
    candidates,
    reasonBreakdown,
    reasonAnnotatedEvents,
  };
}

// Export for gate tests
export { MIN_EVIDENCE, MIN_DISTINCT_STORIES, storyIdentityKey, countDistinctStories };
