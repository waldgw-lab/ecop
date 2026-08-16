// -----------------------------------------------------------------------------
// Curated lane (Task #89) — TWO-TIER clustering over the curated lane.
//
// Inputs: the main feed (headlines/manual via getPrimaryFeed) UNIONed with the
// SEPARATE curated store (curated_items). Every item is assigned a lane TIER
// from the Outlet Registry via findOutlet (unknown → attach-only, fail-closed).
//
// Rules:
//   - A "story" FORMS only when a cluster has >= 2 CONTRIBUTING (trusted) items.
//   - attach-only items (adversary / opinion / low-cred / social / unknown) may
//     only JOIN an already-formed story — they can NEVER seed one.
//   - The representative of a formed story is always its highest-priority
//     CONTRIBUTING item.
//
// Output: membership rows written to the ISOLATED curated_cluster_members table
// (recomputed each run). This NEVER mutates headlines.cluster_id, so the main
// app's Classic/Visual clustering is completely untouched.
// -----------------------------------------------------------------------------
import { openai, createPreferOpenRouter, isTransientAIError, isAIConfigured, aiResponseSnippet } from './aiClient';
import {
  recordCuratedAiCallOk,
  recordCuratedAiCallFailure,
  recordCuratedSynthResynth,
  flushCuratedAiSpendTelemetry,
} from './curatedAiSpend';
import { withAiTimeout, AI_CALL_TIMEOUT_MS, AI_CALL_BACKSTOP_MS } from './aiTimeout';
import { storage } from './storage';
import { curatedEditorialOutcomeQueue } from './curatedEditorialOutcomeQueue';
import { invalidateCuratedReadCache } from './curatedCacheBus';
import { buildOutletIndex, findOutlet, deriveOutletBehavior, isSocialFlashOutlet, type BehaviorClass, type BehaviorLabel } from '@shared/outletRegistry';
import type { CuratedClusterMember, CuratedArchiveMember, CuratedProcessSplitOverlay } from '@shared/schema';
import { isReportedArticleUrl, isEffectivelyReportedArticle, getEffectiveContentKind, isRoundupDigestTitle, isLiveBlogUrl, isLiveUmbrellaTitle, shouldDemoteEffectiveOpinion, deriveContentType } from '@shared/contentKind';
import { isFaviconUrl } from './streamPrefetch';
import { synthesizeStory, synthesisSignature, memberSignatureToken, normalizeMemberUrl, synthesisContentHash, type SynthMember } from './curatedSynthesis';
import { isPriorIdentityReclaimable, isWithinEpisodeAge } from './curatedEpisode';
import { isCuratedMissedMergeReconcileEnabled } from './clusterConfig';
import { normalizeTitle } from './titleNormalizer';
import { normalizeIdentityUrl } from './urlIdentity';
import { CURATED_EVENT_IDENTITY_GUIDANCE } from './curatedEventIdentityGuidance';
import {
  isClusterPhasedOut,
  isDevelopingProcessCluster,
  lastContributingMs,
  archiveMembersPhasedOut,
  freshestContributingContentMs,
  isKineticDominantCluster,
  shouldRefreshStaleSynopsis,
} from './curatedStaleness';
import {
  applySplitOverlays,
  evaluateProcessRepartition,
  findOverlayForEval,
  passesRepartitionGate,
  clusterAgeHours,
  clusterSpanHours,
  SPLIT_SPAN_H,
  SPLIT_SPAN_SIZE_FLOOR,
  shouldEvaluateRepartitionCandidate,
  repartitionBudgetExhausted,
  type SplitAppliedGroup,
  type RepartitionOverlayWrite,
} from './curatedRepartition';
// Re-export the shared staleness helpers so existing importers (e.g.
// scripts/curated-nodecap-repro.ts) keep resolving them from this module.
export { isClusterPhasedOut, isDevelopingProcessCluster, lastContributingMs };

// Smart process re-partition (curated-lane only) — bound on AI calls per pass and
// the minimum cluster size worth even considering as a candidate (the authoritative
// size/age gate lives in evaluateProcessRepartition; this just prunes the loop).
const MAX_REPARTITION_AI_EVALS_PER_PASS = 2;
const REPARTITION_MIN_CANDIDATE_SIZE = 25;
// Early process-prevention (Task #414) — TRUE PREVENTION: split a developing-
// process cluster into a handful of coherent sub-stories AS IT FORMS, before it
// reaches the 50-member backstop. The prevention path gets (a) a LOWER candidate
// floor so smaller process clusters are even looked at, and (b) its OWN small AI
// budget so it can never starve the >=50 backstop (largest-first ordering keeps
// serving the backstop first). Set CURATED_PROCESS_PREVENTION_DISABLED to revert
// to the legacy post-hoc-only behavior (backstop floor + no early gate).
// Lowered 18 -> 15 (Task #440) to match the aged-process recall branch in
// passesRepartitionGate: a developing-process cluster that aged past 16h at a
// modest 15-17 members must ENTER the candidate loop to even reach that gate.
const REPARTITION_PROCESS_MIN_CANDIDATE_SIZE = 15;
const MAX_PREVENTION_AI_EVALS_PER_PASS = 1;
const CURATED_PROCESS_PREVENTION_ENABLED =
  !/^(1|true|yes|on)$/i.test(process.env.CURATED_PROCESS_PREVENTION_DISABLED ?? '');
// Live-blog / live-umbrella node exclusion (Task: mixed-cluster fix). Live
// pages ("/live-…" URL shapes + "…: What's the latest?" recap titles) stitch
// SEVERAL sub-events into one item; even when correctly tiered attach-only
// they still ride in the LLM grouping payload and give the grouping LLM
// textual license to bridge distinct events into one cluster (prod: a Reuters
// "Iran war live" page sat inside a house-vote+tanker mixed megacluster).
// Their coverage is fully duplicated by the single-topic articles, so — like
// roundup digests — they are excluded from the clustering node set entirely.
// Kill-switch mirrors CURATED_PROCESS_PREVENTION_DISABLED.
const CURATED_LIVE_NODE_EXCLUSION_ENABLED =
  !/^(1|true|yes|on)$/i.test(process.env.CURATED_LIVE_NODE_EXCLUSION_DISABLED ?? '');
// Pure predicate (exported for the gate): true when a node is a live-blog /
// live-umbrella page that must not enter the curated clustering node set.
export function isLiveBridgeNode(n: { url: string | null; title: string | null }): boolean {
  return isLiveBlogUrl(n.url) || isLiveUmbrellaTitle(n.title);
}


const CLUSTER_WINDOW_HOURS = 24;
const MIN_CONTRIBUTING_TO_FORM = 2;
const MAX_NODES = 140; // base LLM payload budget — top items by priority
// Recall safeguard (Task #178): the raw priority cap above can orphan a
// lower-priority row that actually belongs to an already-active / forming story
// (when many higher-priority items fill the 140 slots). RESCUE_BUDGET reserves
// extra slots — beyond the priority cap — for two kinds of would-be orphans:
//   (1) members of a still-alive cluster (carried or in-window prior members),
//       so a cap miss never silently dissolves an existing story, and
//   (2) near-duplicate titles of something already selected (very likely the
//       SAME event), so a developing/"new strikes" row gets a chance to join.
// The total stays HARD-bounded (MAX_NODES + RESCUE_BUDGET) so the LLM call can
// never grow unbounded; the index-based output stays tiny regardless.
//
// Starvation fix (Task #1025 follow-up): RESCUE_BUDGET now bounds ONLY the
// CONTINUITY sub-lanes (a) active-cluster and (a2) archive-grace. The near-dup
// sub-lane (b) no longer scavenges pass-1 leftovers — at production volume the
// active members alone consume the whole budget every pass, which starved
// near-dup to 0 permanently. Near-dup now has its own dedicated budget below.
const RESCUE_BUDGET = 60;
// Dedicated near-dup budget (lane (b)). Counted against TOTAL_RESCUE_CEILING
// (it is a recall heuristic, unlike the continuity lanes above).
const NEAR_DUP_RESCUE_BUDGET = 20;
// Event-aware recall (Task #199): at production volume (~1,500 curated items /
// 24h) the flat top-MAX_NODES-by-priority cut sits around priority 75, so an
// ENTIRE same-event group of mid-priority coverage (P70-P85) can fall below the
// cutoff. The Task #178 rescue lane above only recovers overflow rows that match
// something ALREADY in the top window, so when a whole event lives below the
// cut, nothing seeds it and nothing gets rescued — the story fragments into
// standalone rows and attach-only items have no cluster to join. EVENT_BUCKET_BUDGET
// reserves additional slots for WHOLE same-event buckets discovered over the
// FULL over-cap pool (see selectCandidateNodes), admitted together so they can
// clear the >=2-corroborating formation gate. The total stays HARD-bounded.
// Trimmed 80 -> 40 with the starvation fix: under TOTAL_RESCUE_CEILING the lane
// could never actually be granted 80 slots, so the extra headroom was dead —
// 40 still exceeds the lane's reserved floor (24) and allows borrowing slack
// from quiet lanes.
const EVENT_BUCKET_BUDGET = 40;
// Social-flash recall (Task #209): an official social post (X / Truth Social /
// DataMinr) enters curated in reuse-mode at a FIXED low priority (~50), so it
// sits below the flat priority cutoff, and its "title" is tweet PROSE that rarely
// shares enough headline tokens for the Task #178 near-dup lane to catch. Without
// a dedicated lane these posts never co-enter the payload with the story they
// cover, so they can never attach. SOCIAL_RESCUE_BUDGET reserves slots for
// social-flash overflow nodes that plausibly concern a story ALREADY in the
// payload (a real corroborating / primary-origin node). Social is attach-only —
// it can NEVER seed or represent a story — and the LLM + coherence guard + >=2
// formation gate still decide the final attachment, so this only widens RECALL.
const SOCIAL_RESCUE_BUDGET = 40;
// Contrast recall (Task #210): a CONTRAST item (CPC/SWL/EPC alignment OR a
// mixed/low/very-low factuality outlet — deriveBehavior => cls 'anchor-only',
// label 'contrast', e.g. RT / Press TV / TASS / Global Times / Fox News) carries a
// content-based priority that frequently sits below the flat priority cutoff, and
// its headline uses DIVERGENT (propaganda / adversarial) framing that rarely shares
// enough tokens with mainstream coverage for the strict near-dup lane (b) to catch.
// Lane (d) only targets social-flash nodes, so a standalone contrast item never
// co-enters the payload with the story it contrasts and can never attach — the
// coverage breadth it should add is silently lost. CONTRAST_RESCUE_BUDGET mirrors
// the social-flash lane: it reserves bounded slots for contrast overflow nodes that
// plausibly concern a REAL story node already in the payload. Contrast is anchor-only
// (never seeds, represents, or informs facts); the LLM + coherence guard + >=2
// formation gate still decide the final attachment, so this only widens RECALL.
const CONTRAST_RESCUE_BUDGET = 40;
// Identical-title rescue (Task #752 fix): the deterministic same-wire / same-
// article must-link is a CORRECTNESS guarantee — every byte-identical syndicated
// headline from >= 2 distinct publishers MUST co-cluster. It previously shared
// EVENT_BUCKET_BUDGET with event-bucket lane (c); on busy days (many same-event
// buckets) that budget exhausted before all identical-title twins were rescued,
// silently leaving them as separate standalone cards. Giving it a DEDICATED budget
// ensures the correctness guarantee can never be crowded out by recall heuristics.
const IDENTICAL_TITLE_RESCUE_BUDGET = 40;
// Cross-lane rescue ceiling (Task #1025, reworked by the starvation fix).
//
// ORIGINAL DEFECT: the ceiling applied to ALL non-manual lanes in run order, and
// at production volume the continuity lanes (a/a2: 60) plus identical-title (40)
// consumed exactly 100 EVERY pass — so the event-bucket, social and contrast
// lanes rescued 0 forever, whole mid-priority events below the priority cutoff
// never co-entered the LLM payload, and the missed-corroboration alarm re-fired
// with ~45+ unjudgeable groups per pass.
//
// NEW CONTRACT: the ceiling bounds the HEURISTIC recall lanes only —
//   (b) near-dup → (c0) identical-title → (c) event buckets → (d) social → (e) contrast
// The CONTINUITY lanes (a) active-cluster + (a2) archive-grace are EXEMPT (same
// rationale as manual-link (m): keeping a formed story's members co-entering is
// not a recall heuristic; they stay bounded by their own RESCUE_BUDGET).
// Each heuristic lane is additionally protected by a RESERVED FLOOR: when a lane
// runs, it may admit at most
//   min(laneBudget, TOTAL_RESCUE_CEILING - totalRescued - sum(floors of lanes yet to run))
// so an early lane can never starve a later lane below its floor, while quiet
// lanes still lend unused slack to busy ones. Floors sum exactly to the ceiling
// at full saturation: near-dup 20 (budget, no floor needed — it runs first) +
// identical-title 40 (full budget: correctness guarantee, never trimmed) +
// event-bucket 24 + social 8 + contrast 8 = 100.
// Manual-link rescue (m) remains excluded — editor-linked items must always
// co-enter and the number of active links is naturally small.
const TOTAL_RESCUE_CEILING = 100;
// Reserved floors (see contract above). Only lanes that run AFTER another
// heuristic lane need one.
const IDENTICAL_TITLE_RESCUE_FLOOR = IDENTICAL_TITLE_RESCUE_BUDGET; // 40
const EVENT_BUCKET_RESCUE_FLOOR = 24;
const SOCIAL_RESCUE_FLOOR = 8;
const CONTRAST_RESCUE_FLOOR = 8;
// Absolute payload bound. Worst case is now MAX_NODES (140) + continuity
// RESCUE_BUDGET (60) + heuristic TOTAL_RESCUE_CEILING (100) + manual-link, which
// is unbounded in code but naturally small (editor links). MANUAL_LINK_HEADROOM
// keeps the slice generous: manual-link nodes sit FIRST in the rescued array, so
// a binding slice would truncate the TAIL (event-bucket / contrast members) and
// split an admitted bucket — re-breaking the >=2 formation invariant. Never
// tighten this toward the typical payload size.
const MANUAL_LINK_HEADROOM = 100;
const HARD_NODE_CEILING = MAX_NODES + RESCUE_BUDGET + TOTAL_RESCUE_CEILING + MANUAL_LINK_HEADROOM;

// Archive-grace rescue lane (Part B). A formed curated story that drops out of
// Top Stories for a single transient pass (a missed re-formation) but whose
// articles are STILL fresh should be re-admitted to the next clustering payload
// so it can re-form — instead of flapping permanently into the archive. We load
// the recently-seen, NOT-live archive rows (<= ARCHIVE_GRACE_HOURS old), keep
// only those still within their episode window AND not genuinely phased out, and
// collect the normalized URLs of their CONTRIBUTING members (bounded by
// ARCHIVE_GRACE_MAX_URLS). The priority cap's (a2) sub-lane then rescues any live
// candidate matching one of those URLs, bounded by ARCHIVE_GRACE_ADMIT_MAX and
// COUNTED INSIDE RESCUE_BUDGET — so HARD_NODE_CEILING is unchanged.
const ARCHIVE_GRACE_HOURS = 6;
const ARCHIVE_GRACE_MAX_ROWS = 100;
const ARCHIVE_GRACE_MAX_URLS = 250;
const ARCHIVE_GRACE_ADMIT_MAX = 30;

// Build the set of normalized URLs eligible for the (a2) archive-grace rescue
// sub-lane (Part B). From recently-seen, NOT-live archive rows, keep ONLY a
// transiently-missed, still-fresh story — still inside its episode window AND not
// genuinely phased out by the shared staleness rule — and collect the normalized
// URLs of its CONTRIBUTING members only. A phased-out story, an out-of-episode
// story, and an attach-only / adversary member therefore contribute NO rescue
// URL — so a dead story can never be resurrected, and an untrusted repost can
// never resurrect a story. Pure + exported for the regression test; the URL count
// is bounded by ARCHIVE_GRACE_MAX_URLS.
export function buildArchiveGraceMemberUrls(
  rows: ReadonlyArray<{ members?: CuratedArchiveMember[] | null; firstSeenAt?: Date | string | null }>,
  nowMs: number,
): Set<string> {
  const urls = new Set<string>();
  for (const row of rows) {
    if (urls.size >= ARCHIVE_GRACE_MAX_URLS) break;
    const members = (row.members ?? []) as CuratedArchiveMember[];
    const originationMs = row.firstSeenAt ? new Date(row.firstSeenAt).getTime() : null;
    // Only a transiently-missed, still-fresh story qualifies: still inside its
    // episode window AND not genuinely phased out by the shared staleness rule.
    if (!isWithinEpisodeAge(originationMs, nowMs)) continue;
    if (archiveMembersPhasedOut(members, nowMs)) continue;
    // Fail-closed: require actual freshness EVIDENCE. A legacy/unknown-date row
    // whose members carry no usable contributing publishedAt cannot be confirmed
    // fresh (the staleness rule returns "not phased out" only because it has no
    // basis), so it must not seed a rescue URL.
    const hasContribFreshness = members.some(
      (m) =>
        m.behaviorClass === 'corroborating' &&
        m.publishedAt != null &&
        Number.isFinite(new Date(m.publishedAt).getTime()),
    );
    if (!hasContribFreshness) continue;
    for (const m of members) {
      if (urls.size >= ARCHIVE_GRACE_MAX_URLS) break;
      if (m.behaviorClass !== 'corroborating') continue; // contributing only
      const mu = normalizeMemberUrl(m.url);
      if (mu) urls.add(mu);
    }
  }
  return urls;
}
// Trust/volume mix of the PRIMARY cut (Task #311). The flat top-MAX_NODES-by-
// priority selection above is trust-blind: at production volume the highest-
// scoring AND highest-volume non-DataMinr sources are attach-only adversary /
// state media (contrast: RT / TASS / Sputnik / Global Times, plus official social
// and unknown attach), which routinely out-score and out-number the trusted
// CONTRIBUTING (corroborating) outlets. Because these items both score high and
// arrive in bulk, they can consume a large share of the MAX_NODES primary cut and
// push CONTRIBUTING items — the ONLY class that can SEED a story (>=2 to form) —
// down into the overflow, where they return only if a rescue lane happens to
// catch them. Adversary/attach content can NEVER seed or represent a story and it
// already has its own dedicated overflow rescue lanes (social lane (d), contrast
// lane (e)), so letting it dominate the PRIMARY cut is wasted budget at the
// expense of the contributors that actually form stories. PRIMARY_ADVERSARY_CAP
// caps how many adversary/attach nodes may occupy the MAX_NODES primary cut; any
// beyond the cap are DEFERRED to the overflow (where the contrast/social lanes can
// still pull back the ones that relate to a real story), freeing those primary
// slots for the next CONTRIBUTING / primary-anchor items by priority. The cap is a
// CEILING only — when adversary/attach volume is below it nothing changes — and a
// low-volume cycle BACKFILLS any unfilled primary slots from the deferred nodes,
// so the payload is never left shorter than the flat cut. Deterministic and
// bounded: primary stays <= MAX_NODES and HARD_NODE_CEILING is unchanged.
const PRIMARY_ADVERSARY_CAP = Math.floor(MAX_NODES * 0.4); // 56 of 140

// Trust predicate for the primary cut. CONTRIBUTING (corroborating) and primary
// ANCHOR (official release) nodes are protected from the cap below — only
// adversary/attach-only items (CPC/low-factuality CONTRAST state media, official
// SOCIAL, and unknown ATTACH) are capped. These are exactly the classes that can
// never seed/represent a story; contrast and social additionally have their own
// overflow rescue lanes, so capping their share of PRIMARY never loses the breadth
// they legitimately add to a formed story.
function isAdversaryAttachNode(n: LaneNode): boolean {
  return n.cls === 'attach' || (n.cls === 'anchor-only' && n.label === 'contrast');
}
// Carry-over: members of a still-alive cluster are re-injected as nodes even
// after they age out of CLUSTER_WINDOW_HOURS, so a developing story keeps its
// older articles until it phases out. CARRY_LOAD_WINDOW_HOURS only bounds how far
// back prior members are LOADED from the DB; the real phase-out decision is the
// staleness gate below (Task #177), not this load window.
const CARRY_LOAD_WINDOW_HOURS = 24 * 14;
// Per-member rolling-window decay for carry-over. A kept cluster sheds its
// aged-out members whose coverage is no longer part of the current situation,
// so the live card reflects what is happening NOW rather than accumulating
// every report since day 0. Members within this window of NOW are re-injected;
// older members decay off (their coverage already captured in prior archive
// passes). Window is sized to the story type:
//   • Kinetic (strikes / blockade / attacks / interceptions): 24h — the same
//     cadence as the live ingestion window, so only current-situation reporting
//     stays on the card.
//   • Developing process (diplomacy / negotiation): 48h — matches the phase-out
//     ceiling (PHASEOUT_PROCESS_HARD_AGE_H) so a multi-day deal keeps its full
//     earlier reporting while it is still actively updating.
// Members with no publishedAt timestamp are always retained (no basis to decay
// them). A cluster with zero dated members at all falls back to the existing
// all-or-nothing staleness phase-out gate. Curated-lane only, fail-safe.
const CARRY_MEMBER_ROLL_WINDOW_H = 24;
const CARRY_MEMBER_PROCESS_ROLL_WINDOW_H = 48;
// Staleness phase-out constants + helpers (isClusterPhasedOut,
// isDevelopingProcessCluster, lastContributingMs) and the PROCESS vocabulary now
// live in ./curatedStaleness and are imported + re-exported at the top of this
// file (so the storage archive layer can share one source of truth without a
// circular import).

// Scheduled-gathering vocabulary (Task #297). A summit / conference / forum / Gx
// summit / COP is an event ANCHORED to a defined start moment — UNLIKE an
// open-ended negotiation (deal/ceasefire/treaty/talks) it does not just "develop
// over days" as one undifferentiated story. A scheduled gathering has two
// distinct PHASES: anticipation/preview coverage published AHEAD of it, and
// coverage of the event AS IT HAPPENS. Those phases are separate stories and must
// not be folded together, even though the broad multi-day PROCESS exemption would
// otherwise let "summit" coverage span days. Matched against TITLES only.
const SCHEDULED_EVENT_TERM_RE =
  /\b(?:summit|conference|forum|G(?:7|8|20)|G-(?:7|8|20)|COP\d{1,2})\b/i;

// AHEAD-OF / ANTICIPATION cue: coverage published BEFORE a scheduled gathering
// begins — previews, the agenda or what is expected, and who WILL attend, address,
// push, or raise something at it. Conservative: only the clear "looking forward to
// the event" framings, so routine reporting is never mis-tagged as pre-event.
const EVENT_PRE_PHASE_RE =
  /\b(?:ahead\s+of|in\s+the\s+run[- ]?up|run[- ]?up\s+to|days?\s+before|eve\s+of|to\s+(?:attend|address|meet|host|join|speak|travel|arrive|push|raise|discuss|seek|skip|boycott|present|unveil|propose)|will\s+(?:attend|address|meet|host|join|speak|travel|push|raise|seek|discuss|present|propose)|expected\s+to|set\s+to|prepares?\s+for|preparing\s+for|braces?\s+for|gears?\s+up|previews?|anticipat\w+|upcoming|looms?|approaching|to\s+be\s+held)\b/i;

// DURING / AT-THE-EVENT cue: coverage of the gathering as it happens — it
// begins/opens, leaders gather or convene, sideline meetings, its sessions and
// conclusions. Conservative for the same reason.
const EVENT_DURING_PHASE_RE =
  /\b(?:begins?|began|begun|opens?|opened|opening|underway|under\s+way|gets?\s+under\s+way|gathers?|gathered|gathering|convenes?|convened|convening|wraps?\s+up|concludes?|concluded|day\s+(?:one|two|three|1|2|3)\s+of|on\s+the\s+sidelines|at\s+the\s+summit|during\s+the\s+summit|leaders?\s+(?:meet|gather|arrive|convene))\b/i;

// Classify a title's phase WITHIN a scheduled gathering (Task #297): 'pre'
// (anticipation/ahead-of), 'during' (as it happens), or null when the title is not
// about a scheduled gathering OR carries no clear phase cue (or carries BOTH, i.e.
// ambiguous). Deliberately conservative — returning null means "no split", so the
// behavior falls back to today's grouping. Pure + exported for the repro gate.
export function scheduledEventPhase(
  title: string | null | undefined,
): 'pre' | 'during' | null {
  if (!title || !SCHEDULED_EVENT_TERM_RE.test(title)) return null;
  const pre = EVENT_PRE_PHASE_RE.test(title);
  const during = EVENT_DURING_PHASE_RE.test(title);
  if (during && !pre) return 'during';
  if (pre && !during) return 'pre';
  return null; // no cue, or ambiguous (both) — don't split
}

// True when two titles are CLEARLY different phases of a scheduled gathering (one
// pre-event anticipation, the other during/at the event), so they must NOT share a
// recall bucket even when their tokens overlap and they fall within the same-event
// time window. Mirrors the prompt + coherence-guard phase carve-out so the
// deterministic recall lane and the (non-deterministic) LLM agree.
function conflictingScheduledEventPhase(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const pa = scheduledEventPhase(a);
  const pb = scheduledEventPhase(b);
  return !!pa && !!pb && pa !== pb;
}

// isClusterPhasedOut + lastContributingMs moved to ./curatedStaleness (imported
// + re-exported at the top of this file).

// Generic words that carry no event signal — dropped before title-overlap so a
// pair of headlines isn't judged "same event" just because they both say
// "new"/"after"/"strikes report". Crucially this includes the very development
// cues ("new", "after", "latest", …) that Task #178 must NOT treat as evidence
// of a SEPARATE incident: they are noise for matching, not a distinguishing fact.
const NODE_TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'has',
  'have', 'had', 'will', 'would', 'could', 'should', 'its', 'his', 'her',
  'their', 'was', 'were', 'are', 'new', 'after', 'before', 'amid', 'over',
  'into', 'out', 'off', 'near', 'say', 'says', 'said', 'report', 'reports',
  'reported', 'reportedly', 'breaking', 'update', 'updates', 'live', 'latest',
  'news', 'more', 'about', 'than', 'then', 'what', 'when', 'how', 'why',
  'who', 'amidst', 'again', 'now', 'set',
]);

// British/American spelling pairs (Task #598). Two outlets reporting the SAME
// event sometimes spell a key word differently ("data centre" vs. "data
// center"), which makes the raw token sets disjoint even though every other
// word matches. Normalizing onto one canonical (American) spelling BEFORE
// tokenizing lets the existing token-overlap matchers see the real overlap.
// Deliberately a short, reviewable list of common news-vocabulary pairs, not a
// general spell-checker.
const SPELLING_NORMALIZATION: Array<[RegExp, string]> = [
  [/\bcentre(s)?\b/g, 'center$1'],
  [/\bdefence(s)?\b/g, 'defense$1'],
  [/\borganisation(s)?\b/g, 'organization$1'],
  [/\bprogramme(s)?\b/g, 'program$1'],
  [/\blabour(s)?\b/g, 'labor$1'],
  [/\bfavour(s|ed|ing)?\b/g, 'favor$1'],
  [/\bhonour(s|ed|ing)?\b/g, 'honor$1'],
  [/\bmobilisation(s)?\b/g, 'mobilization$1'],
  [/\bauthorisation(s)?\b/g, 'authorization$1'],
  [/\brecognise(d|s)?\b/g, 'recognize$1'],
  [/\bcounsellor(s)?\b/g, 'counselor$1'],
  [/\barmour(ed)?\b/g, 'armor$1'],
  [/\bmanoeuvre(s|d)?\b/g, 'maneuver$1'],
];

// Bounded domain-vocabulary synonym groups (Task #598). Curated headlines
// often name the SAME recurring bill/policy by a different nickname or
// acronym depending on outlet style (e.g. the "NDAA" vs. the "Pentagon bill"
// vs. the "defense bill"). This canonicalizes each KNOWN recurring phrase
// group onto one shared pseudo-token BEFORE the generic tokenizer runs, so
// looksSameEvent / looksRelatedToStory / buildSameEventBuckets / the
// incremental-attach bridge (which all consume significantTitleTokens) see a
// real overlap. Deliberately a short, reviewable allowlist — NOT a general
// synonym engine — so it only ever WIDENS recall for known recurring
// vocabulary and never invents an unrelated merge.
const DOMAIN_VOCAB_SYNONYMS: Array<[RegExp, string]> = [
  [
    /\bndaa\b|\bnational defense authorization act\b|\bnational defence authorization act\b|\bdefense authorization act\b|\bdefence authorization act\b|\bpentagon bill\b|\bdefense spending bill\b|\bdefence spending bill\b|\bdefense bill\b|\bdefence bill\b/g,
    'ndaadefensebill',
  ],
  // Outlets name the same rotary aircraft "helicopter", "helo" (military),
  // "chopper", or "copter"; canonicalize (incl. singular/plural) so two reports
  // of the SAME helicopter incident share this token. One shared token alone can
  // never force a merge (looksSameEvent needs >= 2 shared distinctive tokens), so
  // this only widens recall when a location/actor is ALSO shared.
  [/\bhelicopters?\b|\bhelos?\b|\bchoppers?\b|\bcopters?\b/g, 'helicopter'],
  // Person/role alias (Task #669, narrowed). Outlets refer to the SAME public
  // figure by given name vs. by title/description ("Khamenei" / "Ayatollah Ali
  // Khamenei" / "supreme leader" / "slain leader") — this splintered a ~40-source
  // Khamenei funeral story into an 11-member cluster plus ~30 orphaned standalone
  // cards. Canonicalizing onto one shared pseudo-token lets divergently-named
  // reports of ONE event pair up (looksSameEvent still requires >= 2 shared
  // distinctive tokens overall, so this token alone can never force a merge).
  // Only the EXPLICIT "Khamenei" name forms are aliased unconditionally here; the
  // ambiguous ROLE terms ("supreme leader" / "slain leader" — the press also uses
  // "supreme leader" for Kim Jong-un and the Taliban's Akhundzada) are folded in
  // ONLY under an Iran/Khamenei context, in canonicalizeEventVocabulary below, so
  // three different leaders can no longer bridge together on a fabricated token.
  [
    /\bayatollah ali khamenei\b|\bayatollah khamenei\b|\bkhamenei\b/g,
    'khameneileader',
  ],
];

// Casualty/count context canonicalization (Task #669). A wire story's death
// toll is routinely bumped as it develops ("at least 7" -> "11" -> "12"), so a
// later copy of the SAME article otherwise differs from an earlier one ONLY by
// that number. Short counts (1-2 digits) already fall below significantTitleTokens'
// 3-char minimum and never become tokens at all, but a larger toll (3+ digits)
// DOES become a token and a differing count then fails to overlap. This
// canonicalizes a number that appears in a casualty/count CONTEXT (never a bare
// number elsewhere in the title — a vote count, a squadron number, a percentage,
// etc. are left untouched) onto one shared pseudo-token, so an escalating count
// stops being a point of difference. Deliberately narrow/context-gated: it only
// widens recall for the specific "same wire story, updated toll" case.
const CASUALTY_WORD =
  'dead|kills?|killed|killing|deaths?|casualt(?:y|ies)|wounded|injured|hurt|missing|hospitali[sz]ed|hospitali[sz]ations?';
const CASUALTY_WORD_RE = new RegExp(`\\b(?:${CASUALTY_WORD})\\b`);
const CONTEXT_WINDOW = 25;

// Displacement/evacuation context canonicalization (Task #671). Same escalating-
// number failure mode as casualty tolerance, but for the OTHER human-impact count
// disaster/conflict wires routinely bump as a story develops — the number of
// people evacuated, displaced, left homeless, or stranded ("Over 500 evacuated"
// -> "up to 5,000 people evacuated" as the wire updates). A 3+ digit displacement
// count survives significantTitleTokens' 3-char filter and then makes two copies
// of the SAME story look disjoint on that number alone. Kept in a SEPARATE token
// from casualtycount (not merged into it) on purpose: reusing one shared token
// across impact types would let a casualty story and a displacement story that
// merely share a broad location (e.g. "France") reach the >= 2 shared-token bar
// and false-merge; a distinct token confines recall-widening to
// displacement-with-displacement. Same two invariants as the casualty pass:
// context-gated (never a bare number) and single-token fusion (the count word is
// collapsed into the token, never left as a second surviving token).
const DISPLACEMENT_WORD = 'displaced|evacuated|evacuees?|homeless|stranded';
const DISPLACEMENT_VERB = 'evacuat(?:e|es|ed|ing)|displac(?:e|es|ed|ing)';
const DISPLACEMENT_WORD_RE = new RegExp(`\\b(?:${DISPLACEMENT_WORD})\\b`);
// Optional "people"/"residents"/... connector between a count and the impact
// word ("3,596 people evacuated", "500 residents displaced").
const IMPACT_CONNECTOR = '(?:people|residents|civilians|villagers|families)\\s+';

// Magnitude WORDS that outlets substitute for a numeric impact count (Task
// #672): the SAME wire count is routinely written as a word by some outlets —
// "thousands displaced", "hundreds evacuated", "dozens killed", "scores
// hospitalized" — while others use digits. Without folding the word form onto
// the same shared impact token, a word-count copy and a digit-count copy of one
// story stay disjoint on that count and can fragment into separate standalone
// cards. Only unambiguous PLURAL magnitude words are included, and (exactly like
// the numeric rules) they only canonicalize when a casualty / displacement word
// sits directly after them (through at most an "of"/group-noun connector), so
// "thousands protest", "dozens of lawmakers", or a sports "scores" are never
// touched. A word count sits ABOVE significantTitleTokens' 3-char filter
// ("dozens", "hundreds" all survive), so like a 3+ digit number it otherwise
// becomes a mismatching token. Magnitude words optionally take an "of" before
// the group noun ("thousands of people killed"); digits never do, so allowing
// an optional "of" in these word-specific rules is harmless.
const MAGNITUDE_WORD = 'thousands|hundreds|dozens|scores';

// True when a casualty word appears within CONTEXT_WINDOW chars before or
// after [start, end) in `s` — used to gate the loose "at least <N>" and
// "toll ... <N>" phrasings so they only fire in an actual casualty context
// (e.g. "kills at least 11" / "at least 11 killed"), never for an unrelated
// "at least N" count (a vote margin, lawmakers, funding, seats).
function hasNearbyCasualtyWord(s: string, start: number, end: number): boolean {
  const before = s.slice(Math.max(0, start - CONTEXT_WINDOW), start);
  const after = s.slice(end, end + CONTEXT_WINDOW);
  return CASUALTY_WORD_RE.test(before) || CASUALTY_WORD_RE.test(after);
}

function canonicalizeCasualtyCounts(lower: string): string {
  let s = lower;
  // "at least <N>" -> only fires when a casualty word appears nearby (either
  // side), so unrelated "at least N" counts (votes, lawmakers, funding,
  // seats) are never touched. Collapses the WHOLE "at least N" phrase to a
  // single token (never "at least casualtycount") so no leftover word
  // ("least") can pair with the token to fake a second shared token.
  s = s.replace(
    new RegExp(`\\bat least\\s+(?:\\d[\\d,]*|${MAGNITUDE_WORD})\\b`, 'g'),
    (match, offset: number) =>
      hasNearbyCasualtyWord(s, offset, offset + match.length) ? 'casualtycount' : match,
  );
  // "<N> [people] dead|killed|deaths|casualties|wounded|injured|hurt|missing"
  // — collapses the number AND the casualty word into ONE token. Keeping the
  // word (e.g. "casualtycount dead") would let two UNRELATED "N dead" stories
  // (a bus crash vs. a factory fire) share 2 tokens {casualtycount, dead} and
  // false-merge; a single fused token cannot do that alone.
  s = s.replace(
    new RegExp(`\\b\\d[\\d,]*\\s+(people\\s+)?(${CASUALTY_WORD})\\b`, 'g'),
    'casualtycount',
  );
  // "kills|killed|killing <N>" (no "at least"/trailing-word phrasing above) —
  // same single-token collapse, dropping the verb so it can't survive as a
  // second shared token alongside casualtycount.
  s = s.replace(/\b(kills?|killed|killing)\s+\d[\d,]*\b/g, 'casualtycount');
  // Magnitude WORD in place of a numeric count (Task #672): "<magnitude> [of]
  // [people] <casualty word>" — e.g. "dozens killed", "hundreds dead", "scores
  // of people wounded". Fuse the whole phrase into the single shared token, the
  // same single-token-fusion invariant the numeric rules rely on so two
  // UNRELATED "dozens killed" incidents can't share {casualtycount, killed} and
  // false-merge. Inherently context-gated by the required trailing casualty
  // word, so a non-casualty "dozens"/"hundreds" is never touched.
  s = s.replace(
    new RegExp(`\\b(?:${MAGNITUDE_WORD})\\s+(?:of\\s+)?(?:${IMPACT_CONNECTOR})?(?:${CASUALTY_WORD})\\b`, 'g'),
    'casualtycount',
  );
  // "kills|killed|killing <magnitude>" (verb-before-count-word phrasing, e.g.
  // "airstrike kills dozens") — same single-token collapse, dropping the verb.
  s = s.replace(new RegExp(`\\b(?:kills?|killed|killing)\\s+(?:${MAGNITUDE_WORD})\\b`, 'g'), 'casualtycount');
  // "toll ... <N>" (e.g. "death toll rises to 156") — the wire's own
  // running-count noun, not yet handled by the phrasings above. Requires a
  // casualty word nearby (typically "death"/"casualty" immediately before
  // "toll") so a non-casualty toll (economic/financial toll, toll
  // road/booth/plaza/lane) is never touched. Collapses to a single token
  // ("toll" itself must not survive as a second shared token).
  s = s.replace(/\btoll\b(?!\s*(?:road|booth|plaza|lane))(?:.{0,25}?)\d[\d,]*\b/g, (match, offset: number) =>
    hasNearbyCasualtyWord(s, offset, offset + match.length) ? 'casualtycount' : match,
  );
  // Final sweep: strip any casualty word (e.g. the "death" that preceded a
  // now-collapsed "death toll ... N", or a "kills"/"dead" that survived
  // outside a matched span) that sits immediately adjacent to a
  // "casualtycount" token, so the casualty context is represented by EXACTLY
  // one shared token — never two — regardless of which rule above fired.
  s = s.replace(new RegExp(`\\b(?:${CASUALTY_WORD})\\b`, 'g'), (word, offset: number) => {
    const before = s.slice(Math.max(0, offset - CONTEXT_WINDOW), offset);
    const after = s.slice(offset + word.length, offset + word.length + CONTEXT_WINDOW);
    return /casualtycount/.test(before) || /casualtycount/.test(after) ? '' : word;
  });
  return s;
}

// True when a displacement word appears within CONTEXT_WINDOW chars either side
// of [start, end) — gates the loose "at least <N>" phrasing so it only fires in
// an actual displacement context ("at least 5,000 evacuated"), never for an
// unrelated "at least N" count.
function hasNearbyDisplacementWord(s: string, start: number, end: number): boolean {
  const before = s.slice(Math.max(0, start - CONTEXT_WINDOW), start);
  const after = s.slice(end, end + CONTEXT_WINDOW);
  return DISPLACEMENT_WORD_RE.test(before) || DISPLACEMENT_WORD_RE.test(after);
}

function canonicalizeDisplacementCounts(lower: string): string {
  let s = lower;
  // "at least <N>" -> only fires when a displacement word is nearby, so a
  // non-displacement "at least N" (votes, lawmakers, funding) is never touched.
  // Collapses the WHOLE phrase to one token so no leftover "least" can pair
  // with the token to fake a second shared token.
  s = s.replace(
    new RegExp(`\\bat least\\s+(?:\\d[\\d,]*|${MAGNITUDE_WORD})\\b`, 'g'),
    (match, offset: number) =>
      hasNearbyDisplacementWord(s, offset, offset + match.length) ? 'displacecount' : match,
  );
  // "<N> [people|residents|...] displaced|evacuated|evacuees|homeless|stranded"
  // — collapses the number AND the displacement word into ONE token (never a
  // token + a leftover word), the same single-token-fusion invariant the
  // casualty pass relies on to stop two unrelated same-worded incidents from
  // sharing 2 tokens and false-merging.
  s = s.replace(
    new RegExp(`\\b\\d[\\d,]*\\s+(?:${IMPACT_CONNECTOR})?(?:${DISPLACEMENT_WORD})\\b`, 'g'),
    'displacecount',
  );
  // "evacuate|displace <N>" (verb-before-number phrasing, e.g. "authorities
  // evacuate 5,000") — same single-token collapse, dropping the verb so it
  // can't survive as a second shared token alongside displacecount.
  s = s.replace(new RegExp(`\\b(?:${DISPLACEMENT_VERB})\\s+\\d[\\d,]*\\b`, 'g'), 'displacecount');
  // Magnitude WORD in place of a numeric count (Task #672): "<magnitude> [of]
  // [people] <displacement word>" — e.g. "thousands displaced", "hundreds
  // evacuated", "hundreds of families evacuated", "hundreds of residents
  // evacuated". Fuse the whole phrase onto the single shared displacecount token,
  // same single-token-fusion invariant as the numeric rules; context-gated by
  // the required trailing displacement word.
  s = s.replace(
    new RegExp(`\\b(?:${MAGNITUDE_WORD})\\s+(?:of\\s+)?(?:${IMPACT_CONNECTOR})?(?:${DISPLACEMENT_WORD})\\b`, 'g'),
    'displacecount',
  );
  // "evacuate|displace <magnitude>" (verb-before-count-word phrasing, e.g.
  // "authorities evacuate thousands") — same single-token collapse.
  s = s.replace(new RegExp(`\\b(?:${DISPLACEMENT_VERB})\\s+(?:${MAGNITUDE_WORD})\\b`, 'g'), 'displacecount');
  // Final sweep: strip any displacement word left immediately adjacent to a
  // "displacecount" token so the displacement context is EXACTLY one shared
  // token regardless of which rule above fired.
  s = s.replace(new RegExp(`\\b(?:${DISPLACEMENT_WORD})\\b`, 'g'), (word, offset: number) => {
    const before = s.slice(Math.max(0, offset - CONTEXT_WINDOW), offset);
    const after = s.slice(offset + word.length, offset + word.length + CONTEXT_WINDOW);
    return /displacecount/.test(before) || /displacecount/.test(after) ? '' : word;
  });
  return s;
}

// Money-figure de-bridge (lever D — multi-crisis over-merge). A large money
// figure ("$100 billion", "$100bn", "$1.5 trillion") tokenizes into a 3+ digit
// number token PLUS a magnitude token (billion/bn/bln/trillion/million) — TWO
// shared tokens. Two UNRELATED money stories from one busy day (TSMC's $100bn
// chip plant, a $100bn Pentagon program, a $100bn oil-tanker deal) then share
// {100, billion} and clear the >= 2 shared-token looksSameEvent/looksRelated
// recall bar, welding distinct events into one topically-incoherent
// megacluster. This collapses a money figure to a SINGLE token, and — OUTSIDE a
// defense-spending context — removes it entirely, so a bare dollar amount can
// never be the 2-token bridge that false-merges unrelated events.
//
// Symmetric in MECHANISM to the casualty/displacement passes (single-token
// fusion, context-gated, never a bare number elsewhere) but OPPOSITE in intent:
// those two WIDEN recall (one shared token helps an updated-count copy of the
// SAME wire re-merge); this one is a PRECISION de-bridge. In a defense-spending
// context the amount is a genuine same-event signal (two reports of the same
// budget/procurement/arms deal), so it keeps ONE shared token; out of context
// it contributes zero tokens. Either way it can no longer supply the SECOND
// shared token that the >= 2 bar needs, which is the whole welding vector.
const MONEY_MAGNITUDE = 'billion|billions|bn|bln|trillion|trillions|tn|million|millions';
// Defense-spending context words: the figure is a military/defense outlay
// (budget, procurement, arms/weapons program, military aid). Only THEN is the
// amount worth keeping as one shared corroboration token. Deliberately
// spending/hardware-oriented, not every geopolitics word.
const DEFENSE_SPEND_WORD =
  'defen[sc]e|military|pentagon|weapons?|arms|missiles?|munitions?|warheads?|arsenal|artillery|warships?|submarines?|aircraft|jets?|fighters?|procure\\w*|appropriat\\w*|rearm\\w*|deterren\\w*|budget|defense aid|military aid';
const DEFENSE_SPEND_WORD_RE = new RegExp(`\\b(?:${DEFENSE_SPEND_WORD})\\b`);
const MONEY_CONTEXT_WINDOW = 40;

// True when a defense-spending word appears within MONEY_CONTEXT_WINDOW chars
// either side of [start, end). Gates a money figure so it fuses to one shared
// token only when it is a defense outlay, and is otherwise removed.
function hasNearbyDefenseSpendWord(s: string, start: number, end: number): boolean {
  const before = s.slice(Math.max(0, start - MONEY_CONTEXT_WINDOW), start);
  const after = s.slice(end, end + MONEY_CONTEXT_WINDOW);
  return DEFENSE_SPEND_WORD_RE.test(before) || DEFENSE_SPEND_WORD_RE.test(after);
}

function canonicalizeMoneyFigures(lower: string): string {
  let s = lower;
  // (A) Dollar-prefixed amounts, with or without a magnitude word: "$100
  // billion", "$100bn", "$1.5 trillion", "$500 million", "$100" (and a trailing
  // "dollars"/"usd" if present). The leading "$" GUARANTEES it is money, so no
  // magnitude is required and there is no risk of eating a human-impact count.
  // Runs AFTER the casualty/displacement passes so those claim any "N killed" /
  // "N displaced" numbers first; a money figure never carries their trailing
  // impact word, so they never collide.
  s = s.replace(
    new RegExp(`\\$\\s*\\d[\\d,.]*\\s*(?:${MONEY_MAGNITUDE})?\\s*(?:dollars?|usd)?\\b`, 'g'),
    (match, offset: number) =>
      hasNearbyDefenseSpendWord(s, offset, offset + match.length) ? ' moneyfigure ' : ' ',
  );
  // (B) Magnitude money WITHOUT a "$": "100 billion in chips", "1.5 trillion".
  // Restricted to billion/trillion (never bare "million") so a large human count
  // like "2 million refugees" / "3 million troops" is NOT mistaken for money;
  // billion/trillion in a news headline is money in practice. Optional trailing
  // "dollars"/"usd" folded in so it can't survive as its own shared token.
  s = s.replace(
    new RegExp(`\\b\\d[\\d,.]*\\s*(?:billion|billions|bn|bln|trillion|trillions|tn)\\s*(?:dollars?|usd)?\\b`, 'g'),
    (match, offset: number) =>
      hasNearbyDefenseSpendWord(s, offset, offset + match.length) ? ' moneyfigure ' : ' ',
  );
  return s;
}

function canonicalizeEventVocabulary(lower: string): string {
  let s = canonicalizeCasualtyCounts(lower);
  s = canonicalizeDisplacementCounts(s);
  // De-bridge money figures AFTER the human-impact passes have claimed their
  // "N killed" / "N displaced" numbers, so a money amount is never mistaken for
  // (or clobbered by) an impact count.
  s = canonicalizeMoneyFigures(s);
  for (const [re, repl] of DOMAIN_VOCAB_SYNONYMS) s = s.replace(re, repl);
  // Context-gated Khamenei role alias (Task #669, narrowed). "supreme leader" /
  // "slain leader" are AMBIGUOUS alone (also Kim Jong-un, the Taliban's
  // Akhundzada), so fold them onto the Khamenei pseudo-token ONLY when the SAME
  // title already carries an Iran/Khamenei signal — either "khameneileader" (set
  // just above from an explicit "Khamenei" mention) or iran/iranian/tehran/
  // ayatollah. This keeps the funeral-story recall win without bridging unrelated
  // leaders into one cluster on a bare "supreme leader".
  if (/\b(?:khameneileader|iran|iranian|tehran|ayatollah)\b/.test(s)) {
    s = s.replace(/\bsupreme leader\b|\bslain leader\b/g, 'khameneileader');
  }
  for (const [re, repl] of SPELLING_NORMALIZATION) s = s.replace(re, repl);
  return s;
}

// Conservative singular/plural fold so "drones"/"drone", "strikes"/"strike",
// "talks"/"talk" count as the SAME token across the recall nets (titles-highly-
// similar, looksSameEvent, body-aware matching). Precision bars (min shared
// tokens / overlap ratios) are UNCHANGED — this only stops legitimate same-event
// pairs from missing them on trivial morphology. Deliberately narrow: only a
// trailing "s" on tokens of >= 5 chars, and never after "s"/"u"/"i" (keeps
// "mass", "crisis", "status", "news"(len 4) intact). Not a stemmer.
function foldPluralToken(w: string): string {
  if (w.length >= 5 && w.endsWith('s') && !/[sui]s$/.test(w)) return w.slice(0, -1);
  return w;
}

// Significant lowercase tokens of a title (>= 3 chars, non-stopword). Used only
// to decide whether an OVERFLOW node looks like the same event as something
// already in the payload — a cheap recall gate, never a clustering decision.
export function significantTitleTokens(title: string | null | undefined): Set<string> {
  if (!title) return new Set();
  return new Set(
    canonicalizeEventVocabulary(title.toLowerCase())
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !NODE_TITLE_STOPWORDS.has(w))
      .map(foldPluralToken),
  );
}

// Body-aware token extension (Task #747). Combines title tokens with significant
// tokens from the FIRST body snippet (leading AI bullet or summary). Used when a
// headline is thin but the body names the distinctive actors/facts — e.g. a
// quote-based headline ("Revenge will most certainly be carried out") that names
// the speaker and context only in the body. Capped at CANDIDATE_BODY_TOKENS_MAX
// so a verbose body never dominates the title signal. Exported so the incremental-
// attach bridge can share this ONE chokepoint for all same-event token matching.
const CANDIDATE_BODY_TOKENS_MAX = 40;
export function significantCandidateTokens(
  n: Pick<LaneNode, 'title' | 'bullets' | 'summary'>,
): Set<string> {
  const title = significantTitleTokens(n.title);
  const raw = (n.bullets && n.bullets.find(b => b && b.trim())) || n.summary || null;
  if (!raw) return title;
  const body = new Set(
    canonicalizeEventVocabulary(raw.toLowerCase())
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !NODE_TITLE_STOPWORDS.has(w))
      .map(foldPluralToken)
      .slice(0, CANDIDATE_BODY_TOKENS_MAX),
  );
  return new Set([...title, ...body]);
}

// Stable-identity reuse match (Task #301). Decides whether a freshly FORMED
// curated story is a CONTINUATION of a prior-pass story (so it can reclaim that
// story's stored clusterId across membership churn, instead of minting a fresh
// member-set hash and leaving a phantom "phased out" archive duplicate behind).
// Returns a positive score (higher = stronger continuation) when it matches, or
// null when it does NOT — so two genuinely distinct concurrent stories never
// collapse onto one id. Pure + deterministic: vetoes on a known category OR
// subject-region conflict; a positive needs strong member-set containment OR a
// closely matching representative headline. Region is compared case-insensitively
// (the same URL-keyed overlay the archive layer uses supplies it upstream).
export interface StoryIdentityMatchInput {
  tokens: Set<string>; // member-signature tokens (the natural-hash input set)
  headTokens: Set<string>; // representative-title significant tokens
  category: string | null;
  region: string | null;
}
export function priorIdentityMatchScore(
  current: StoryIdentityMatchInput,
  prior: StoryIdentityMatchInput,
): number | null {
  // Category veto — both known and different => not the same story.
  const categoryKnownBoth = !!(current.category && prior.category);
  if (categoryKnownBoth && current.category !== prior.category) return null;
  // Region (subject-geography) veto — both known and different => not the same.
  const regionKnownBoth = !!(current.region && prior.region);
  const regionEqual =
    regionKnownBoth && current.region!.toLowerCase() === prior.region!.toLowerCase();
  if (regionKnownBoth && !regionEqual) return null;
  // Member-set overlap via containment over the SMALLER set (so a big swing in
  // source count still recognizes the continuation) + headline agreement.
  let shared = 0;
  for (const t of prior.tokens) if (current.tokens.has(t)) shared++;
  if (shared === 0) return null;
  const denom = Math.min(current.tokens.size, prior.tokens.size);
  if (denom === 0) return null;
  const containment = shared / denom;
  let inter = 0;
  for (const t of current.headTokens) if (prior.headTokens.has(t)) inter++;
  const union = current.headTokens.size + prior.headTokens.size - inter;
  const headSim = union > 0 ? inter / union : 0;
  // Topical compatibility (Task #356): category AND region are BOTH known and
  // equal. This is the strongest non-overlap evidence that two passes describe
  // the SAME ongoing event. It does two things, BOTH curated-lane only and
  // strictly additive:
  //   (a) RELAXES the overlap bar so a continuing mega-story whose source SET
  //       swings hard pass-to-pass (gaining/shedding dozens of sources, with a
  //       reworded representative headline) still reclaims its prior identity
  //       instead of minting a fresh small fragment — the exact split-into-many
  //       symptom this task fixes. Containment over the SMALLER set already
  //       absorbs count swings; this lowers the floor for the in-between case
  //       where containment dips below 0.5 and the headline below 0.5.
  //   (b) BIASES the score so the argmax prefers a same-category/region prior
  //       over a bare token-overlap prior.
  // It can NEVER bridge a category/region conflict (the vetoes above already
  // returned null) and the relaxed branch still REQUIRES >= 2 shared REAL member
  // articles, so a single shared wire-service pickup, or an opposite-direction
  // counter-strike (which shares few/no article URLs with the strike it answers),
  // can never trip it. Two genuinely distinct concurrent stories essentially
  // never share >= 2 identical article URLs, so false merges stay closed.
  const categoryEqual = categoryKnownBoth; // (a conflict was already vetoed above)
  const topicallyCompatible = categoryEqual && regionEqual;
  const isMatch =
    containment >= 0.5 ||
    (containment >= 0.25 && headSim >= 0.5) ||
    (headSim >= 0.75 && shared >= 2) ||
    (topicallyCompatible && shared >= 2 && (containment >= 0.34 || headSim >= 0.34));
  if (!isMatch) return null;
  const compatibilityBonus = (regionEqual ? 0.25 : 0) + (categoryEqual ? 0.15 : 0);
  return containment + headSim + compatibilityBonus;
}

// Heuristic "these two titles are probably the SAME event" check used ONLY to
// rescue an overflow node into the LLM payload (Task #178). Deliberately
// permissive — a false positive merely lets the LLM (and the coherence guard)
// consider one extra candidate, it NEVER forces a cluster. Requires >= 2 shared
// significant tokens AND either 3+ shared or a >= 0.4 overlap coefficient against
// the smaller token set, so a lone generic word ("strikes") can't match alone.
// NOTE (Task #598): a single shared word — even a seemingly distinctive one like
// a company/person/place name — is deliberately NOT enough on its own (pinned by
// the "anthropic" transitive-precision regression test): the same proper noun
// often anchors several genuinely UNRELATED stories about that subject. Recall
// for divergently-worded same-event reports is widened instead via vocabulary
// normalization in significantTitleTokens (spelling + bounded domain synonyms)
// and via the clustering-prompt guidance, not by loosening this token-count gate.
export function looksSameEvent(a: Set<string>, b: Set<string>): boolean {
  if (a.size < 2 || b.size < 2) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  small.forEach(t => { if (large.has(t)) shared++; });
  if (shared < 2) return false;
  return shared >= 3 || shared / small.size >= 0.4;
}

// Bounded body snippet appended to each clustering-prompt line (Task #617).
// The headline alone often omits the distinctive subject (ship/operation/
// person) that the body names — two reports of the SAME incident can share
// zero distinctive title words while both bodies plainly name the same thing.
// This gives the grouping LLM that substance without inflating the prompt:
// one short clause drawn from the first summary bullet (preferred, already a
// terse fact) or else the leading slice of the free-text summary. Falls back
// to no snippet (title-only) for un-enriched attach-only items, exactly as
// before this task. Kept to a small character cap per item since the node
// ceiling can put many items in one payload.
const CLUSTER_SNIPPET_MAX_CHARS = 140;
export function buildClusteringBodySnippet(
  n: Pick<LaneNode, 'bullets' | 'summary'>,
): string | null {
  const raw = (n.bullets && n.bullets.find((b) => b && b.trim())) || n.summary || null;
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  if (cleaned.length <= CLUSTER_SNIPPET_MAX_CHARS) return cleaned;
  return `${cleaned.slice(0, CLUSTER_SNIPPET_MAX_CHARS).trimEnd()}...`;
}

// Pure formatter for a single numbered clustering-prompt line (Task #617).
// Extracted so the snippet-append behavior is unit-testable at runtime without
// invoking the LLM. Tags each item with how long ago it was published (so the
// model can apply the time rules) and appends " -- <snippet>" when a body
// snippet exists; un-enriched nodes stay title-only exactly as before.
export function formatClusteringPromptLine(
  n: Pick<LaneNode, 'title' | 'source' | 'publishedAt' | 'bullets' | 'summary'>,
  idx: number,
  nowMs: number,
): string {
  const t = n.publishedAt ? new Date(n.publishedAt).getTime() : NaN;
  let when = 'time unknown';
  if (Number.isFinite(t)) {
    const ageH = Math.round((nowMs - t) / 3_600_000);
    when = ageH <= 0 ? 'just now' : ageH === 1 ? '1h ago' : `${ageH}h ago`;
  }
  const snippet = buildClusteringBodySnippet(n);
  const snippetPart = snippet ? ` -- ${snippet}` : '';
  return `${idx + 1}. "${n.title}" (${n.source}, ${when})${snippetPart}`;
}

// Relaxed "this overflow item is plausibly ABOUT this story" check (Task #209,
// shared with Task #210). Used ONLY to rescue an attach-style overflow node — an
// official social post (lane d) or a CONTRAST item (lane e) — into the LLM payload
// against a real story node already in the payload. Looser than looksSameEvent (no
// overlap coefficient floor) because such an item's wording shares fewer headline
// tokens than a second trusted outlet's headline does: a tweet is prose, and a
// CPC/low-factuality outlet frames the same event with divergent (propaganda)
// language. Still requires >= 2 shared SIGNIFICANT tokens so a single generic word
// ("strikes") can't pull an off-topic item in. A false positive merely hands the
// LLM + coherence guard one more candidate to judge; both social and contrast are
// attach/anchor-only and can never seed or represent a story.
export function looksRelatedToStory(a: Set<string>, b: Set<string>): boolean {
  if (a.size < 2 || b.size < 2) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  small.forEach(t => { if (large.has(t)) shared++; });
  return shared >= 2;
}

// Corroborating reports of ONE incident cluster within a news cycle. Coverage
// separated by a large time gap — a different calendar day, a "second night" /
// "second day", a later wave of an ongoing conflict — is a DISTINCT incident even
// when the wording (and therefore the title tokens) overlaps heavily (e.g.
// "US strikes Iran" 26h ago vs. "Iran targets US bases for a second night" 11h
// ago). The title-token heuristics above are time-blind, so this window stops the
// recall gate from UNIONing two different-cycle events into one bucket. It is
// deliberately generous so it never splits genuine same-cycle corroboration; the
// time-aware LLM prompt (which now sees each item's age) makes the fine call.
export const SAME_EVENT_WINDOW_HOURS = 12;

// True when two items are close enough in time to plausibly be the SAME event.
// A missing/invalid timestamp falls back to permissive (token-only) matching so a
// row whose publish time is unknown is never silently dropped from recall.
// Exported (Task #439) so the incremental-attach bridge + its read-only recall
// diagnostic reuse the EXACT same time window the clustering pass uses.
export function withinSameEventWindow(
  a: Date | string | null | undefined,
  b: Date | string | null | undefined,
): boolean {
  if (!a || !b) return true;
  const at = new Date(a).getTime();
  const bt = new Date(b).getTime();
  if (!Number.isFinite(at) || !Number.isFinite(bt)) return true;
  return Math.abs(at - bt) / 3_600_000 <= SAME_EVENT_WINDOW_HOURS;
}

// Cross-pass member-confirmation hysteresis (Task #645). A member is shown once
// it is either non-provisional (trusted Phase-A core, always shown immediately)
// OR provisional AND confirmed by >= 2 consecutive passes (the incremental-attach
// bridge + semantic adversary-attach writers persist confirmedStreak — see the
// write sites below and in curatedIncrementalAttach.ts). Exported so BOTH read
// paths in server/routes.ts (the embedded top-stories member list feeding
// sourceCount, and the /api/curated/cluster-members by-clusterId fetch) apply the
// EXACT same gate and can never drift out of sync with each other, and so it is
// unit-testable in isolation from the DB/route layer.
export const CURATED_MEMBER_CONFIRM_THRESHOLD = 2;
export function isConfirmedCuratedMember(m: {
  provisional?: boolean | null;
  confirmedStreak?: number | null;
}): boolean {
  return !m.provisional || (m.confirmedStreak ?? 0) >= CURATED_MEMBER_CONFIRM_THRESHOLD;
}

let isClusteringRunning = false;
// Wall-clock start of the pass that currently holds `isClusteringRunning`, plus a
// monotonic run token (Task #741). Together these let a NEW pass reclaim the lock
// if a PRIOR pass ever truly wedges (never settles, so its `finally` never runs):
// without this, one non-abortable hang would leave `isClusteringRunning` true
// forever and silently freeze every future clustering pass — Top Stories would
// stop refreshing until a process restart. The run token also stops a stale pass
// that finally un-wedges from clearing a fresher pass's guard in its own finally.
let clusteringStartedAt: number | null = null;
let clusteringRunToken = 0;

// When a manual link/merge arrives while a full clustering pass holds the single
// lock, we record it here so the merge is never silently deferred to the next
// ~5-minute cron. The finally block fires the reshape the instant the lock frees.
// Curated-lane only; fail-closed (never exported to main-feed callers).
let pendingManualReshapeAfterPass: { forceSynthesis: boolean; maxDurationMs?: number } | null = null;
let manualReshapeDrainScheduled = false;

// The AbortController of the FULL clustering pass currently holding the lock (null
// when idle or when only a cheap deterministic re-shape is running). An editor
// mutation trips this via requestCuratedClusteringYield so the wedged pass yields
// the lock early and the deferred manual re-shape can land. Curated-lane only.
let currentFullPassAbort: AbortController | null = null;

// Cross-pass "judged pairs" suppression cache (Task #1025). Pairs that were fed
// into the fuzzy missed-merge must-link but STILL didn't form a story are marked
// "ruled out" so the same pair doesn't alarm pass after pass. Keys are sorted
// node-URL pairs ("<normalised-url-a>|<normalised-url-b>"); values are expiry
// timestamps. Entries expire after JUDGED_PAIR_TTL_MS so a genuinely new story
// with the same outlets/wording isn't silenced permanently. Curated-lane only;
// in-process only — no DB write needed (the alarm is advisory, not enforcement).
// Raised 4h -> 12h (Task #1088): prod showed the same already-judged pairs
// re-alarming (and re-burning fuzzy must-link AI budget) as soon as the 4h TTL
// lapsed while both stories were still live. 12h outlasts a typical story's
// live window; a genuinely NEW same-outlet story still re-qualifies next day.
const JUDGED_PAIR_TTL_MS = 12 * 60 * 60 * 1000;
const judgedMissedMergePairs = new Map<string, number>(); // pairHash -> expiresAtMs

// A full pass gets this long an un-preemptible head start before an editor action
// may abort it. Keeps healthy fast passes intact (their deferred re-shape fires
// on completion anyway) and bounds full-pass starvation under rapid edits, while
// still preempting the AI-stalled passes that actually cause editor lag.
const CURATED_YIELD_MIN_PASS_AGE_MS = 3_000;

// Short hard-timeout budget for an editor MERGE/LINK's background synthesis pass.
// A manual merge lands INSTANTLY via the synchronous deterministic reshape (the
// card is already visible with its representative's title); the follow-up
// forceSynthesis pass only regenerates the short AI headline + key facts, which
// is a nicety, not a blocker. That pass, however, takes the SINGLE shared
// clustering lock for its whole duration — and a single synthesis LLM call can
// stall up to AI_CALL_BACKSTOP_MS (75s) under a prod rate-limit storm. While the
// lock is held, the editor's NEXT merge/link is deferred, so rapid successive
// edits serialize behind each other's slow AI call. Bounding this pass to a
// short budget releases the lock quickly: in the normal case the single new
// story synthesizes well within it; in the pathological (rate-limited) case the
// pass aborts at the boundary WITHOUT completing synthesis and the headline
// simply regenerates on the next cron pass — the merge itself is unaffected.
// Curated-lane only.
export const MANUAL_MERGE_SYNTHESIS_MAX_MS = 30 * 1000; // 30s

/**
 * Schedule a deterministic re-shape to run the instant the current clustering
 * pass finishes. Safe to call from any hot path — coalesces into ONE pending
 * request; never throws. Curated-lane only.
 */
export function schedulePendingManualReshape(forceSynthesis = false, maxDurationMs?: number): void {
  if (pendingManualReshapeAfterPass) {
    if (forceSynthesis) pendingManualReshapeAfterPass.forceSynthesis = true;
    // Keep the TIGHTER of any two requested budgets so a bounded manual-merge
    // synthesis can never be widened back to an unbounded pass by coalescing.
    if (maxDurationMs != null) {
      pendingManualReshapeAfterPass.maxDurationMs =
        pendingManualReshapeAfterPass.maxDurationMs != null
          ? Math.min(pendingManualReshapeAfterPass.maxDurationMs, maxDurationMs)
          : maxDurationMs;
    }
    kickManualReshapeDrain();
    return;
  }
  pendingManualReshapeAfterPass = { forceSynthesis, maxDurationMs };
  console.log(
    '[CuratedCluster] Pending manual re-shape scheduled — will fire the instant the current pass finishes',
  );
  kickManualReshapeDrain();
}

/**
 * One process-wide drain for all background editor reshapes. Requests arriving
 * before the microtask starts coalesce into one pass; requests arriving while a
 * pass is running remain pending and become at most one consolidated follow-up.
 */
function kickManualReshapeDrain(): void {
  if (manualReshapeDrainScheduled || isClusteringRunning || !pendingManualReshapeAfterPass) return;
  manualReshapeDrainScheduled = true;
  queueMicrotask(() => {
    manualReshapeDrainScheduled = false;
    if (isClusteringRunning || !pendingManualReshapeAfterPass) return;
    const pending = pendingManualReshapeAfterPass;
    pendingManualReshapeAfterPass = null;
    console.log('[CuratedCluster] Firing coalesced background manual re-shape...');
    void reshapeCuratedLane({
      forceSynthesis: pending.forceSynthesis,
      maxDurationMs: pending.maxDurationMs,
    })
      .then((result) => {
        if (!result.skipped) {
          invalidateCuratedReadCache('top-stories');
          invalidateCuratedReadCache('cluster-members');
          console.log(
            `[CuratedCluster] Background manual re-shape complete — stories: ${result.stories}, members: ${result.members}`,
          );
        }
      })
      .catch((err) => {
        console.warn(
          '[CuratedCluster] Background manual re-shape failed (non-fatal; next cron retries):',
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => kickManualReshapeDrain());
  });
}

// EDITOR-PRIORITY YIELD (curated-lane only). When an editor link/merge/evict/
// unlink arrives while a FULL clustering pass holds the single lock, trip that
// pass's existing hard-timeout AbortController early. The pass stops queueing new
// AI work at its next phase boundary and returns via the AbortError fast-path,
// which is contractually BEFORE the destructive replaceCuratedClusterMembers
// write — so existing clusters are preserved and the full pass simply re-runs on
// its next cron. The instant the lock frees, the deferred manual re-shape fires
// (see the finally block), so the editor's action lands in seconds instead of
// waiting out a pass whose synthesis calls can each stall up to the AI backstop
// under a provider-latency storm. No-op (returns false) if no full pass is in
// flight or it is already aborting. Never touches the main feed.
export function requestCuratedClusteringYield(reason: string): boolean {
  const ctrl = currentFullPassAbort;
  if (!ctrl || ctrl.signal.aborted) return false;
  // Starvation guard: don't preempt a FRESH pass. A healthy full pass completes
  // quickly and its deferred re-shape fires within seconds anyway; only a pass
  // that has already held the lock past this threshold looks AI-stalled — the
  // exact case that makes editor actions feel backlogged. This also bounds
  // full-pass starvation under rapid edits: every new pass gets an
  // un-preemptible head start to make real regrouping progress.
  const heldForMs = clusteringStartedAt != null ? Date.now() - clusteringStartedAt : Infinity;
  if (heldForMs >= CURATED_YIELD_MIN_PASS_AGE_MS) {
    console.log(
      `[CuratedCluster] Editor action (${reason}) requested clustering yield — aborting the in-flight full pass early (held ${Math.round(heldForMs / 1000)}s) so the manual re-shape lands promptly (existing clusters preserved)`,
    );
    ctrl.abort();
    return true;
  }
  // Still within the head-start window — schedule a single deferred re-attempt so
  // a pass that stalls RIGHT AFTER starting still gets preempted. Bind to the
  // current run token so a stale timer can never abort a different, later pass.
  const tokenAtSchedule = clusteringRunToken;
  const waitMs = CURATED_YIELD_MIN_PASS_AGE_MS - heldForMs;
  const timer = setTimeout(() => {
    if (clusteringRunToken !== tokenAtSchedule) return; // a newer pass owns the lock
    const c = currentFullPassAbort;
    if (c && !c.signal.aborted) {
      console.log(
        `[CuratedCluster] Editor action (${reason}) deferred yield firing after head start — aborting the still-running full pass (existing clusters preserved)`,
      );
      c.abort();
    }
  }, waitMs);
  timer.unref?.();
  console.log(
    `[CuratedCluster] Editor action (${reason}) yield deferred ~${Math.round(waitMs / 1000)}s — full pass still within its ${Math.round(CURATED_YIELD_MIN_PASS_AGE_MS / 1000)}s head start`,
  );
  return false;
}

// Hard wall-clock bound for a single clustering pass (Task #716). Under an AI
// rate-limit storm every LLM sub-call is already bounded by withAiTimeout, but
// a pass that walks a long fallback chain across MANY phase loops (grouping,
// coherence guard, re-partition, semantic attach, synthesis, anchor-split) can
// still keep queueing NEW model work for many minutes after it should have given
// up — hammering the shared AI client. This arms an AbortController; the phase
// boundaries + per-cluster LLM loops below check its signal and STOP starting
// new work once it fires (mirrors the curatedIngest early-stop pattern). Set
// comfortably above a normal pass and above the ~225s worst-case all-providers
// grouping timeout so it never fires on a healthy run. Curated-lane only.
const CLUSTER_MAX_DURATION_MS = 10 * 60 * 1000; // 10 min

// Test-only override for the hard-timeout budget (Task #742). The 10-minute
// production budget can't be waited out in a regression test, so the early-stop
// test injects a tiny duration to trip the abort signal mid-pass and prove the
// phase-boundary checks actually fire. Production always leaves this null and
// uses CLUSTER_MAX_DURATION_MS unchanged — no production behavior changes.
let clusterMaxDurationOverrideMs: number | null = null;
export function __setClusterMaxDurationForTest(ms: number | null): void {
  clusterMaxDurationOverrideMs = ms;
}

// Stale-lock ceiling (Task #741). If `isClusteringRunning` is still held this long
// after a pass STARTED, that pass is treated as abandoned and a new pass may
// reclaim the guard. Set ABOVE both the internal hard-timeout (10 min) and the
// scheduler cron's outer race backstop (12 min) so a healthy — even legitimately
// long — pass always settles and releases the guard on its own well before this
// fires; only a truly wedged (never-settling) pass is ever reclaimed here.
// Curated-lane only.
const CLUSTER_STALE_GUARD_MS = 15 * 60 * 1000; // 15 min

// Cooperative-cancellation checkpoint (Task #716; mirrors curatedIngest's
// throwIfAborted). Throws an AbortError-shaped error at a phase boundary once
// the pass's hard-timeout signal has fired, so clusterCuratedLane's outer catch
// returns the PRESERVE result ({ stories: 0, members: 0 }) WITHOUT ever reaching
// the destructive replaceCuratedClusterMembers write below — existing Top Stories
// are kept intact, exactly like the AI-timeout preserve contract. Placed only at
// boundaries BEFORE that write; loops inside fail-safe try/catch blocks use a
// plain `signal.aborted` break instead (a throw there would be swallowed).
function throwIfClusterAborted(signal: AbortSignal | undefined, label?: string): void {
  if (signal?.aborted) {
    const err = new Error(`Curated clustering cancelled${label ? ` (${label})` : ''}`);
    err.name = 'AbortError';
    throw err;
  }
}

// A clustered story's representative supplies the story's url, thumbnail and
// content-kind badge, so picking a video/opinion as the face makes the WHOLE
// multi-source news cluster inherit a "Video"/"Opinion" tag. We prefer a real
// article as the representative when one corroborates the same story.
// isReportedArticleUrl lives in @shared/contentKind so the client badge, this
// engine and the Top Stories route all classify URLs the same way.

// Legacy role persisted in curated_cluster_members.role.
type Tier = 'contributing' | 'anchor-only' | 'attach-only';

export interface LaneNode {
  key: string; // `${itemType}:${itemId}`
  itemType: 'main' | 'curated';
  itemId: string;
  title: string;
  source: string;
  url: string;
  category: string | null;
  // Behavior class drives formation/representative; role is the persisted label.
  cls: BehaviorClass;
  label: BehaviorLabel;
  role: Tier;
  blocked: boolean;
  priority: number;
  ogImageUrl: string | null;
  // Page-detected content kind (curated-lane). 'audio' marks a podcast/audio
  // story so it can never be elected the cluster representative (mirrors how a
  // URL-detected video is excluded), while still counting toward formation.
  // Optional so existing test fixtures that omit it default to non-audio.
  contentKind?: string | null;
  publishedAt: Date | null;
  // Synthesis context (Task #90): registry-derived source identifier + factuality,
  // plus the item's own summary/bullets — fed to the synthesizer for lede/facts/spin.
  sourceIdentifier: string | null;
  factuality: string | null;
  ownership: string[];
  summary: string | null;
  bullets: string[] | null;
  // True when this node is an official/flash SOCIAL post (Task #209). Set at
  // node-build time from the resolved outlet (isSocialFlashOutlet); drives the
  // social-flash rescue lane in selectCandidateNodes. Optional so existing test
  // fixtures that omit it default to a non-social node.
  isSocialFlash?: boolean;
  // Canonical normalized title (the ingest dedup key) for the deterministic
  // identical-title must-link layer. Sourced from headlines/curated_items
  // .normalized_title; falls back to normalizeTitle(title) for carried/legacy
  // nodes and test fixtures. Optional so existing fixtures default to undefined.
  normalizedTitle?: string | null;
}

export interface ClusterGroup {
  keys: string[];
}

// Event-aware recall (Task #199): group a pool of nodes into cheap "same-event"
// buckets BEFORE the LLM, so members of one event that ALL live below the flat
// priority cutoff still co-enter the payload TOGETHER. Without this, a mid-priority
// event (several outlets reporting the same strike at P70-P85) is split across the
// top-N boundary at production volume — some members make the cut, the rest never
// reach the model in the SAME call, the >=2-corroborating formation gate never
// sees them together, and the story fragments into standalone rows (and attach-only
// items have no formed cluster to join). This only widens RECALL: the LLM and the
// coherence guard still make the final grouping decision. Buckets are built over
// the existing significantTitleTokens/looksSameEvent heuristics AND a same-event
// time window (withinSameEventWindow), so two different-cycle events that merely
// share wording (e.g. a strike 26h ago vs. a "second night" 11h later) never
// land in the same bucket. The bucket grows by TRANSITIVE
// single-link BFS out from the anchor (the bucket's first CONNECTOR node;
// buckets are seeded from connectors first so a non-connector that precedes its
// connector in the pool is still swept in, not orphaned as a singleton): a
// candidate joins when it looksSameEvent ANY existing bucket member,
// not only the anchor — so a string of same-event reports where no single
// pairwise match spans the whole set (DW~JPost~Bloomberg, but DW and Bloomberg
// don't directly match) still lands in ONE bucket instead of fragmenting. To
// keep this purely a RECALL widening and prevent a precision regression, only a
// real story-forming member (corroborating, or a primary-origin anchor) may act
// as a CONNECTOR/bridge — an attach-only / contrast / social node can JOIN a
// bucket but can NEVER fuse two otherwise-unrelated reports together. Every
// joiner is still bounded to ~SAME_EVENT_WINDOW_HOURS around the ANCHOR's
// publishedAt, so transitive token chaining can't drift the bucket across news
// cycles. O(n^2) over small token sets — cheap even across the full over-cap
// pile.
export function buildSameEventBuckets(nodes: LaneNode[]): LaneNode[][] {
  const tokenSets = nodes.map(n => significantTitleTokens(n.title));
  const isConnector = (k: number) =>
    nodes[k].cls === 'corroborating' ||
    (nodes[k].cls === 'anchor-only' && nodes[k].label === 'primary');
  const bucketIdx = new Array<number>(nodes.length).fill(-1);
  const buckets: number[][] = [];
  // Pass 1 — seed buckets from CONNECTORS only, in pool order. Seeding from
  // connectors FIRST is what lets a non-connector (attach / contrast / social)
  // that happens to appear EARLIER in the pool than the connector it belongs to
  // still get swept into that connector's bucket, instead of being prematurely
  // emitted as its own singleton and then locked out (it is only marked assigned
  // once a connector's BFS reaches it). The BFS expands ONLY from connector
  // members, so a non-connector can JOIN a bucket but never bridge two reports;
  // every joiner stays within the same-event window of the anchor (nodes[i], the
  // bucket's first connector).
  for (let i = 0; i < nodes.length; i++) {
    if (bucketIdx[i] !== -1 || !isConnector(i)) continue;
    const b = buckets.length;
    bucketIdx[i] = b;
    const members = [i];
    const queue = [i];
    while (queue.length) {
      const cur = queue.shift()!;
      if (!isConnector(cur)) continue;
      for (let j = 0; j < nodes.length; j++) {
        if (bucketIdx[j] !== -1) continue;
        if (!withinSameEventWindow(nodes[i].publishedAt, nodes[j].publishedAt)) continue;
        // Scheduled-gathering phase split (Task #297): a pre-event anticipation
        // item and a during-event item are DIFFERENT phases of the same summit and
        // must not share a bucket, even when their tokens overlap and they fall
        // within the same-event window. Checked against the bucket ANCHOR (nodes[i])
        // like the time window, so a 'during'-seeded bucket never absorbs a 'pre'
        // member and vice versa.
        if (conflictingScheduledEventPhase(nodes[i].title, nodes[j].title)) continue;
        if (!looksSameEvent(tokenSets[cur], tokenSets[j])) continue;
        bucketIdx[j] = b;
        members.push(j);
        queue.push(j);
      }
    }
    buckets.push(members);
  }
  // Pass 2 — every node still unassigned is a non-connector that matched no
  // connector bucket; emit it as its own singleton so the result still partitions
  // the pool (every node appears in exactly one bucket).
  for (let i = 0; i < nodes.length; i++) {
    if (bucketIdx[i] !== -1) continue;
    bucketIdx[i] = buckets.length;
    buckets.push([i]);
  }
  return buckets.map(idxs => idxs.map(k => nodes[k]));
}

// -----------------------------------------------------------------------------
// DETERMINISTIC IDENTICAL-TITLE MUST-LINK (curated syndication merge).
//
// The curated grouping itself is delegated to the LLM; the deterministic lanes
// only govern CANDIDACY — they never FORCE a merge. That leaves a real gap: two
// BYTE-IDENTICAL headlines from two distinct trusted outlets (Sightline Media
// syndication — e.g. Defense News + Military Times running the SAME wire) render
// as two separate standalone Top Stories whenever the LLM fails to group them in
// a pass. This layer closes the gap deterministically: nodes that share the EXACT
// normalized title, from >= 2 DISTINCT publishers, within the same-event window,
// MUST co-cluster regardless of the LLM output. It NEVER weakens the formation
// gate (>= 2 corroborating from >= 2 distinct publishers still decides what forms),
// it only forces obvious same-article duplicates into ONE group.
// -----------------------------------------------------------------------------

// Robust outlet identity for the must-link distinct-publisher gate. Domain is the
// stable key (ignores path/query variance); falls back to the source name, then
// the node key, so two genuinely-different outlets never over-collapse. Mirrors
// the inline publisherKey the formation gate uses so both layers agree on "same
// outlet".
function publisherKeyOf(n: LaneNode): string {
  if (n.url) {
    try { return new URL(n.url).hostname.replace(/^www\./i, '').toLowerCase(); } catch { /* fall through */ }
  }
  const s = (n.source ?? '').trim().toLowerCase();
  return s || `key:${n.key}`;
}

// FORMATION GATE (pure, exported for the end-to-end ingest -> cluster ->
// formed-story regression gate, Task #604). A group FORMS a story only when it
// holds >= MIN_CONTRIBUTING_TO_FORM CORROBORATING members drawn from
// >= MIN_CONTRIBUTING_TO_FORM DISTINCT publishers. Anchor-only / attach-only /
// contrast members carry NO formation weight, and N copies of ONE outlet's
// article count as a SINGLE source (publisherKeyOf keys on domain), so a clone
// that escaped URL dedup can never stand up a fake multi-source story. This is
// the SAME logic the live clusterCuratedLane pass applies inline — extracted so
// both agree on exactly what forms and so the guarantee is unit-testable without
// the LLM/DB. `sourceCount` here is the distinct-corroborating-publisher count
// the gate enforces; the read path's DISPLAYED sourceCount is the cluster's total
// member rows, which is always >= this for any story that forms.
export interface FormationResult {
  forms: boolean;
  corroboratingCount: number;
  sourceCount: number; // distinct corroborating publishers
}
export function evaluateFormation(groupNodes: LaneNode[]): FormationResult {
  const corroborating = groupNodes.filter(n => n.cls === 'corroborating');
  const distinctPublishers = new Set(corroborating.map(publisherKeyOf));
  const forms =
    corroborating.length >= MIN_CONTRIBUTING_TO_FORM &&
    distinctPublishers.size >= MIN_CONTRIBUTING_TO_FORM;
  return {
    forms,
    corroboratingCount: corroborating.length,
    sourceCount: distinctPublishers.size,
  };
}

// -----------------------------------------------------------------------------
// SUSPECTED MISSED-CORROBORATION DIAGNOSTIC (Task #626). Read-only alarm that
// flags STANDALONE Curated Top Stories which SHOULD have merged into one
// corroborated story but didn't — the silent-regression symptom that appears if
// the live clustering LLM stops grouping obvious fuzzy near-dupes (e.g. after a
// model / prompt change). The deterministic must-link already force-merges
// BYTE-IDENTICAL syndication and the #604 test pins that; this catches the
// GENUINELY-FUZZY near-dupe case that only the (non-deterministic) LLM stage
// handles, which no fast validation gate can cover. Pure + deterministic +
// curated-lane only; it NEVER auto-remerges (observability only) — a flag hands
// the team a pair to eyeball, nothing more.
//
// A group is flagged only when every pairwise link clears a HIGH-PRECISION bar,
// deliberately much stricter than the permissive recall heuristics
// looksSameEvent / looksRelatedToStory (which are tuned to OVER-admit into the
// LLM payload):
//   - both titles carry >= MISSED_MERGE_MIN_TOKENS significant tokens,
//   - they share >= MISSED_MERGE_MIN_SHARED significant tokens,
//   - the overlap coefficient over the SMALLER token set >= MISSED_MERGE_MIN_OVERLAP,
//   - the two items fall within the SAME same-event time window clustering uses,
// and the resulting connected group draws from >= MIN_CONTRIBUTING_TO_FORM
// DISTINCT publishers (the exact formation-gate corroboration bar). Only
// CORROBORATING nodes are considered — attach / anchor / contrast carry NO
// formation weight, so their being standalone is never a missed merge. High
// precision is intentional: this is an alarm a human reads, so a false alarm is
// worse than a missed one.
// -----------------------------------------------------------------------------
const MISSED_MERGE_MIN_TOKENS = 4;
const MISSED_MERGE_MIN_SHARED = 3;
const MISSED_MERGE_MIN_OVERLAP = 0.6;

// High-precision "these two standalone titles clearly describe the same event"
// test. Stricter than looksSameEvent: requires a real token count on both sides,
// a substantial absolute shared-token count, AND a high overlap coefficient over
// the smaller set — so a couple of shared generic words can never trip it.
export function titlesHighlySimilar(a: Set<string>, b: Set<string>): boolean {
  if (a.size < MISSED_MERGE_MIN_TOKENS || b.size < MISSED_MERGE_MIN_TOKENS) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  small.forEach(t => { if (large.has(t)) shared++; });
  if (shared < MISSED_MERGE_MIN_SHARED) return false;
  return shared / small.size >= MISSED_MERGE_MIN_OVERLAP;
}

// -----------------------------------------------------------------------------
// MUTUAL-EXCHANGE FRAMING DETECTOR (Task #806).
//
// Returns true when a headline (and optionally a body snippet) is framed around
// a MUTUAL exchange of attacks — both actors trading strikes simultaneously —
// rather than a single-direction strike by one actor on the other.
//
// Vocabulary is deliberately tight:
//   • "exchange" must co-occur within 60 chars of an attack word.
//   • "trade" must co-occur within 40 chars of an attack word.
//   • "tit-for-tat", "each other" + attack verb, "both sides" + attack verb.
// Non-attack "exchange" (prisoner swap, currency, diplomacy) and non-attack
// "trade" (tariffs, commerce) are excluded because they carry no attack word.
//
// A single-direction headline ("US strikes Iran", "Iran retaliates") must NOT
// match — verified by the regression test. Exported so the test harness can
// call it directly. Curated-lane only; no effect on other feeds.
// -----------------------------------------------------------------------------

// Attack-word pattern — intentionally excludes generic words like "barbs",
// "accusations", "insults" that appear in diplomatic, not military, exchanges.
const EXCHANGE_ATTACK_RE = /\b(strikes?|fire|blows?|attacks?|missiles?|shells?|rockets?|salvos?|barrages?|bombs?|drones?|munitions?)\b/i;

// Patterns for mutual-exchange language. Each must co-occur with or embed an
// attack word, or itself imply mutual violence (tit-for-tat, each other).
const EXCHANGE_FRAMING_PATTERNS: RegExp[] = [
  // "exchange[d/s] strikes/fire/..." — attack word within 60 chars after "exchange"
  /\bexchanged?\s+(?:\w+\s+){0,6}(strikes?|fire|blows?|attacks?|missiles?|shells?|rockets?|salvos?|barrages?|bombs?)\b/i,
  // "strikes/fire exchanged" — attack word before "exchanged"
  /\b(strikes?|fire|blows?|attacks?|missiles?|shells?|rockets?)\b[^.]{0,40}\bexchanged\b/i,
  // "trade[d/s/ing] strikes/fire/..." — attack word within 40 chars
  /\btrad(?:es?|ed|ing)\s+(?:\w+\s+){0,5}(strikes?|fire|blows?|attacks?|missiles?|shells?|rockets?|salvos?|bombs?)\b/i,
  // "tit-for-tat" always implies mutual action
  /\btit-for-tat\b/i,
  // "[verb] each other" — mutual action
  /\b(bomb|strike|attack|fire|shoot|hit)(?:ed|ing|s)?\s+(?:at\s+)?each\s+other\b/i,
  // "strikes each other" variant
  /\bstrik(?:es?|ing)\s+each\s+other\b/i,
  // "both sides" + attack verb
  /\bboth\s+sides?\b[^.]{0,50}\b(struck?|attacked?|fires?|fired|launched?|hit|bombed?|shelled?)\b/i,
  // "mutual exchange of fire/strikes"
  /\bmutual\b[^.]{0,30}\b(exchange|strikes?|fire|attack)\b/i,
  // "cross-border exchange" (of fire implied)
  /\bcross-?border\s+exchange\b/i,
];

export function isMutualExchangeFraming(title: string, summary?: string | null): boolean {
  const text = summary ? `${title} ${summary}` : title;
  return EXCHANGE_FRAMING_PATTERNS.some(p => p.test(text));
}

// -----------------------------------------------------------------------------
// ACTOR-PAIR EXTRACTOR (Task #806).
//
// Given a headline, returns a SORTED pair of canonical actor names if exactly
// two known actors appear, otherwise null (can't safely merge an ambiguous or
// unknown pair). The small alias map covers the recurring conflict actors;
// unknown actors yield null (fail-closed). Sort order is alphabetical so
// "US|Iran" and "Iran|US" produce the same key. Exported for testing.
// -----------------------------------------------------------------------------

interface ActorDef { canonical: string; aliases: string[] }
const ACTOR_DEFS: ActorDef[] = [
  { canonical: 'US',          aliases: ['united states', '\\bu\\.?s\\.?\\b', 'washington', 'american', 'pentagon'] },
  { canonical: 'Iran',        aliases: ['iran', 'iranian', 'tehran', 'irgc'] },
  { canonical: 'Israel',      aliases: ['israel', 'israeli', 'jerusalem', '\\bidf\\b'] },
  { canonical: 'Russia',      aliases: ['russia', 'russian', 'moscow', 'kremlin'] },
  { canonical: 'Ukraine',     aliases: ['ukraine', 'ukrainian', '\\bkyiv\\b', '\\bkiev\\b'] },
  { canonical: 'China',       aliases: ['china', 'chinese', 'beijing', '\\bprc\\b'] },
  { canonical: 'North Korea', aliases: ['north korea', 'north korean', 'pyongyang', '\\bdprk\\b'] },
  { canonical: 'Hezbollah',   aliases: ['hezbollah'] },
  { canonical: 'Hamas',       aliases: ['\\bhamas\\b'] },
  { canonical: 'Houthis',     aliases: ['houthi', 'houthis', '\\byemeni?\\b', 'ansarallah'] },
  { canonical: 'Pakistan',    aliases: ['pakistan', 'pakistani', 'islamabad'] },
  { canonical: 'India',       aliases: ['\\bindia\\b', 'indian', 'new delhi'] },
];

// Pre-compile alias regexes once at module load
const ACTOR_PATTERNS: { canonical: string; re: RegExp }[] = ACTOR_DEFS.map(({ canonical, aliases }) => ({
  canonical,
  re: new RegExp(aliases.join('|'), 'i'),
}));

export function extractActorPair(title: string): [string, string] | null {
  const found: string[] = [];
  for (const { canonical, re } of ACTOR_PATTERNS) {
    if (re.test(title) && !found.includes(canonical)) {
      found.push(canonical);
    }
  }
  if (found.length !== 2) return null;
  return [found[0], found[1]].sort() as [string, string];
}

export interface SuspectedMissedMerge {
  keys: string[];
  titles: string[];
  publishers: string[];
}

// Group STANDALONE (un-clustered) curated nodes that look like the SAME event
// yet failed to merge. Pure + deterministic: single-link union-find over the
// high-precision pairwise bar above, then keep only connected components with
// >= 2 distinct publishers (i.e. a group that WOULD have passed the formation
// gate had the LLM grouped it). Never mutates its input; never merges anything.
export function findSuspectedMissedMerges(standalone: LaneNode[]): SuspectedMissedMerge[] {
  const nodes = standalone.filter(n => n.cls === 'corroborating' && !n.blocked);
  const n = nodes.length;
  if (n < 2) return [];
  const tokens = nodes.map(x => significantTitleTokens(x.title));
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (i: number, j: number) => {
    const a = find(i), b = find(j);
    if (a !== b) parent[a] = b;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!withinSameEventWindow(nodes[i].publishedAt, nodes[j].publishedAt)) continue;
      if (!titlesHighlySimilar(tokens[i], tokens[j])) continue;
      union(i, j);
    }
  }
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const arr = byRoot.get(r) ?? [];
    arr.push(i);
    byRoot.set(r, arr);
  }
  const flagged: SuspectedMissedMerge[] = [];
  for (const idxs of Array.from(byRoot.values())) {
    if (idxs.length < 2) continue;
    const members = idxs.map(i => nodes[i]);
    const publishers = new Set(members.map(publisherKeyOf));
    if (publishers.size < MIN_CONTRIBUTING_TO_FORM) continue;
    flagged.push({
      keys: members.map(m => m.key),
      titles: members.map(m => m.title),
      publishers: Array.from(publishers),
    });
  }
  return flagged;
}

// Body-aware variant of findSuspectedMissedMerges (Task #747). Uses combined
// title+body tokens (significantCandidateTokens) instead of title-only tokens,
// so a thin-headline node whose body names the distinctive actors/facts is
// correctly paired with a headline-rich node covering the same event. Same
// precision bar (MISSED_MERGE_MIN_TOKENS / MISSED_MERGE_MIN_SHARED /
// MISSED_MERGE_MIN_OVERLAP) and same publisher gate (>= 2 distinct) as the
// title-only version — only the TOKEN INPUTS widen. Used to drive the
// must-link reconcile pass (full-mode only) so standalone pairs that body-match
// are forced into one cluster deterministically, gated by the unchanged
// evaluateFormation guard. Exported so the incremental-attach bridge can reuse
// the same detection logic. Pure + deterministic; never mutates its input.
export function findBodyAwareMissedMerges(standalone: LaneNode[]): SuspectedMissedMerge[] {
  const nodes = standalone.filter(n => n.cls === 'corroborating' && !n.blocked);
  const n = nodes.length;
  if (n < 2) return [];
  // For each node, pre-compute both the title-only tokens and the combined
  // (title+body) token set. The comparison logic tries three directions:
  //   1. combined(i) vs combined(j)   — both have rich bodies
  //   2. combined(i) vs titleOnly(j)  — i body reveals event j's title names
  //   3. titleOnly(i) vs combined(j)  — j body reveals event i's title names
  // Using cross-direction (2/3) means a thin headline (< 4 significant title
  // tokens) can still match a rich headline by having its body supply the event
  // tokens, checked against the rich title's tight curated set. This keeps the
  // denominator small (the rich title's ~4-5 tokens), so even 4 shared tokens
  // produce a 0.8 overlap — well above the 0.6 bar. Standard titlesHighlySimilar
  // precision rules (MIN_TOKENS, MIN_SHARED, MIN_OVERLAP) are unchanged.
  const titleToks = nodes.map(x => significantTitleTokens(x.title));
  const combined = nodes.map(x => significantCandidateTokens(x));
  const bodyAwareSimilar = (i: number, j: number): boolean =>
    titlesHighlySimilar(combined[i], combined[j]) ||
    titlesHighlySimilar(combined[i], titleToks[j]) ||
    titlesHighlySimilar(titleToks[i], combined[j]);
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (i: number, j: number) => {
    const a = find(i), b = find(j);
    if (a !== b) parent[a] = b;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!withinSameEventWindow(nodes[i].publishedAt, nodes[j].publishedAt)) continue;
      if (!bodyAwareSimilar(i, j)) continue;
      union(i, j);
    }
  }
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const arr = byRoot.get(r) ?? [];
    arr.push(i);
    byRoot.set(r, arr);
  }
  const flagged: SuspectedMissedMerge[] = [];
  for (const idxs of Array.from(byRoot.values())) {
    if (idxs.length < 2) continue;
    const members = idxs.map(i => nodes[i]);
    const publishers = new Set(members.map(publisherKeyOf));
    if (publishers.size < MIN_CONTRIBUTING_TO_FORM) continue;
    flagged.push({
      keys: members.map(m => m.key),
      titles: members.map(m => m.title),
      publishers: Array.from(publishers),
    });
  }
  return flagged;
}

// -----------------------------------------------------------------------------
// UNIFIED SAME-EVENT CONSOLIDATION (fundamental revision of the missed-merge
// mechanisms). ONE union-find pass over "units" — formable LLM groups (>= 2
// corroborating non-blocked members, the formation gate's own bar) and
// standalone corroborating nodes — replaces the three former partial lanes:
//
//   1. the body-aware fuzzy standalone lane (Task #747): standalone <-> standalone
//   2. the cross-cluster rep-vs-rep lane (Task #752): one rep pair per group,
//      which missed phase-worded fragments whose reps shared only 3/6 tokens
//   3. the post-formation one-merge-per-pass backstop (Task #1085): capped at a
//      single group pair per pass, so a 4-way phase split needed 3+ passes
//
// Evidence is evaluated over ALL cross member pairs, not just reps — so an
// evolving event whose phase-worded reps diverge ("announces pact" -> "signs
// deal" -> "approves deal") still links through its interior members that
// carry the shared event vocabulary.
//
// Precision rules (validated against the 2026-07-22 US-Saudi nuclear-deal
// 6-cluster fragmentation in prod):
//   • group <-> group pairs use TITLE-vs-TITLE evidence only and require >= 2
//     INDEPENDENT links (>= 2 distinct members on EACH side, each pair passing
//     titlesHighlySimilar + the same-event window). Body tokens are excluded
//     here because reaction/angle clusters ("Israel fears the deal") share
//     body vocabulary with the event cluster while their titles stay below
//     the 0.6 bar — title evidence keeps legitimate separate angles separate.
//   • any pair involving a standalone keeps the fuzzy lane's body-aware
//     3-direction matching (combined/titleOnly cross-checks) and needs 1 link.
//   • two groups resolving to the SAME split overlay never merge — the AI
//     re-partition deliberately separated them (findOverlayForEval).
//   • a union that would exceed MISSED_MERGE_RECONCILE_MAX_COMBINED total
//     members is skipped (megacluster guard).
//   • budgets: components containing >= 1 formable group are capped per pass;
//     standalone-only components keep the former fuzzy-lane budget.
//
// Edges are processed in descending evidence order (peak shared tokens, then
// link count, then lexicographic unit-id pair) so caps and budgets bind
// deterministically. Pure + exported for the regression gate. Downstream is
// unchanged: components feed reconcileMustLinkGroups, then manual evictions /
// moves, the formation gate, coherence guard and rep selection all still run —
// nothing is forced into a story that wouldn't otherwise qualify, and editor
// overrides still beat every automatic merge.
// -----------------------------------------------------------------------------

// Max components per pass that touch >= 1 formable group (each one re-shapes a
// formed story and triggers a re-synthesis — bound the per-pass churn).
// Raised 8 -> 12 (duplicate-story fix): prod metrics showed
// missed_merge_reconciled pinned at EXACTLY 8 every pass against a ~40-group
// suspected-missed-merge backlog — the budget was the binding constraint, so
// duplicate cards (same event split across stories) never consolidated. Fixed
// bump, not backlog-adaptive; MISSED_MERGE_RECONCILE_MAX_COMBINED and the
// titlesHighlySimilar / cross-group >=2-link precision bars are deliberately
// untouched (over-merge guards).
// Raised 12 -> 24 (Task #1088): the suspected-missed-merge alarm kept reporting
// a 33–35 pair backlog against the old budgets pass after pass — the budget,
// not precision, was again the binding constraint (same failure mode as the
// 8 -> 12 bump above). Precision bars stay untouched.
const SAME_EVENT_GROUP_COMPONENT_BUDGET = 24;
// Standalone-only components keep the former fuzzy-lane recall budget.
// Raised 30 -> 60 (Task #1088) for the same backlog-starvation reason.
const SAME_EVENT_STANDALONE_BUDGET = 60;
// Independent cross-links required before two formed/formable groups merge.
const SAME_EVENT_CROSS_GROUP_MIN_LINKS = 2;

export interface SameEventMergeInput {
  groups: ClusterGroup[];
  nodes: LaneNode[];
  overlays?: CuratedProcessSplitOverlay[];
  // Admin safety valve (the missed-merge-reconcile toggle): when false, any
  // edge touching a formable group is skipped — degrading to exactly the old
  // standalone-only fuzzy behavior instead of going fully dark.
  allowCrossGroupMerges?: boolean;
}

export interface SameEventMergeResult {
  mustLinkGroups: string[][];
  // Components merging >= 2 formable groups (the former backstop's symptom).
  crossGroupComponents: number;
  // Components folding standalones into exactly 1 formable group.
  foldComponents: number;
  // Standalone-only components (the former fuzzy lane's output).
  standaloneComponents: number;
}

export function buildSameEventMergeComponents(input: SameEventMergeInput): SameEventMergeResult {
  const empty: SameEventMergeResult = {
    mustLinkGroups: [],
    crossGroupComponents: 0,
    foldComponents: 0,
    standaloneComponents: 0,
  };
  const corroborating = input.nodes.filter(n => n.cls === 'corroborating' && !n.blocked);
  if (corroborating.length < 2) return empty;
  const overlays = input.overlays ?? [];
  const allowCrossGroup = input.allowCrossGroupMerges !== false;

  // --- Units: formable groups first (full key sets ride along), then every
  // corroborating node not in a formable group as its own standalone unit.
  // Members of UNFORMABLE groups act standalone (Task #1025 semantics) — when
  // one must-links elsewhere, reconcileMustLinkGroups pulls its whole group in.
  type Unit = {
    id: string;
    keys: string[];
    corr: LaneNode[];
    isGroup: boolean;
    overlayId: string | null;
  };
  const corrByKey = new Map(corroborating.map(n => [n.key, n]));
  const units: Unit[] = [];
  const formableKeys = new Set<string>();
  for (const g of input.groups) {
    const corr = g.keys
      .map(k => corrByKey.get(k))
      .filter((n): n is LaneNode => !!n);
    if (corr.length < MIN_CONTRIBUTING_TO_FORM) continue;
    const sortedKeys = [...g.keys].sort();
    for (const k of g.keys) formableKeys.add(k);
    let overlayId: string | null = null;
    if (overlays.length > 0) {
      try {
        overlayId = findOverlayForEval(corr, overlays)?.id ?? null;
      } catch {
        overlayId = null;
      }
    }
    units.push({ id: `g:${sortedKeys[0]}`, keys: sortedKeys, corr, isGroup: true, overlayId });
  }
  for (const n of corroborating) {
    if (formableKeys.has(n.key)) continue;
    units.push({ id: `s:${n.key}`, keys: [n.key], corr: [n], isGroup: false, overlayId: null });
  }
  if (units.length < 2) return empty;
  units.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // --- Per-node token caches (title-only + combined title+body).
  const titleToks = new Map<string, Set<string>>();
  const combinedToks = new Map<string, Set<string>>();
  for (const n of corroborating) {
    titleToks.set(n.key, significantTitleTokens(n.title));
    combinedToks.set(n.key, significantCandidateTokens(n));
  }
  const sharedCount = (a: Set<string>, b: Set<string>): number => {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let shared = 0;
    small.forEach(t => { if (large.has(t)) shared++; });
    return shared;
  };

  // --- Candidate edges between unit pairs.
  type Edge = { i: number; j: number; peak: number; links: number; bothGroups: boolean };
  const edges: Edge[] = [];
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const A = units[i];
      const B = units[j];
      const bothGroups = A.isGroup && B.isGroup;
      if (!allowCrossGroup && (A.isGroup || B.isGroup)) continue;
      // Same split overlay -> the re-partition deliberately separated these
      // children; never glue them back together.
      if (bothGroups && A.overlayId !== null && A.overlayId === B.overlayId) continue;
      let peak = 0;
      const distinctA = new Set<string>();
      const distinctB = new Set<string>();
      for (const a of A.corr) {
        for (const b of B.corr) {
          if (!withinSameEventWindow(a.publishedAt, b.publishedAt)) continue;
          const aT = titleToks.get(a.key)!;
          const bT = titleToks.get(b.key)!;
          let evidence = 0;
          if (bothGroups) {
            if (titlesHighlySimilar(aT, bT)) evidence = sharedCount(aT, bT);
          } else {
            const aC = combinedToks.get(a.key)!;
            const bC = combinedToks.get(b.key)!;
            if (
              titlesHighlySimilar(aC, bC) ||
              titlesHighlySimilar(aC, bT) ||
              titlesHighlySimilar(aT, bC)
            ) {
              evidence = Math.max(sharedCount(aC, bC), sharedCount(aC, bT), sharedCount(aT, bC));
            }
          }
          if (evidence === 0) continue;
          distinctA.add(a.key);
          distinctB.add(b.key);
          if (evidence > peak) peak = evidence;
        }
      }
      const links = Math.min(distinctA.size, distinctB.size);
      const required = bothGroups ? SAME_EVENT_CROSS_GROUP_MIN_LINKS : 1;
      if (links < required) continue;
      edges.push({ i, j, peak, links, bothGroups });
    }
  }
  if (edges.length === 0) return empty;
  edges.sort(
    (x, y) =>
      y.peak - x.peak ||
      y.links - x.links ||
      (`${units[x.i].id}|${units[x.j].id}` < `${units[y.i].id}|${units[y.j].id}` ? -1 : 1),
  );
  // Apply ALL group<->group edges before any standalone-involving edge. Two
  // formed groups may only unite on DIRECT title-vs-title evidence (>= 2
  // independent links, same-overlay pairs already excluded above). Without this
  // ordering + the bridge guard below, a single standalone with body-aware
  // 1-link edges to BOTH groups would transitively glue them together —
  // bypassing exactly the precision bar that keeps distinct angles (explainers,
  // reaction stories sharing event vocabulary) out of the main event cluster.
  const orderedEdges = [...edges.filter(e => e.bothGroups), ...edges.filter(e => !e.bothGroups)];

  // --- Union-find with per-union guards (combined-size cap + budgets), applied
  // in evidence order so the strongest merges always win the budget.
  const parent = units.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const rootKeyCount = units.map(u => u.keys.length);
  const rootHasGroup = units.map(u => u.isGroup);
  const rootMerged = units.map(() => false);
  let groupComponentsUsed = 0;
  let standaloneComponentsUsed = 0;
  for (const e of orderedEdges) {
    const ra = find(e.i);
    const rb = find(e.j);
    if (ra === rb) continue;
    // Bridge guard: a standalone-involving edge must never be the thing that
    // unites two components which EACH already contain a formed group — that
    // union needs direct group<->group evidence (already applied first above).
    if (!e.bothGroups && rootHasGroup[ra] && rootHasGroup[rb]) continue;
    if (rootKeyCount[ra] + rootKeyCount[rb] > MISSED_MERGE_RECONCILE_MAX_COMBINED) continue;
    const resultHasGroup = rootHasGroup[ra] || rootHasGroup[rb];
    // Budget bookkeeping: subtract each side's current merged-component slot,
    // add the resulting component's slot, and only commit if within caps.
    let g = groupComponentsUsed;
    let s = standaloneComponentsUsed;
    if (rootMerged[ra]) { if (rootHasGroup[ra]) g--; else s--; }
    if (rootMerged[rb]) { if (rootHasGroup[rb]) g--; else s--; }
    if (resultHasGroup) g++; else s++;
    if (g > SAME_EVENT_GROUP_COMPONENT_BUDGET || s > SAME_EVENT_STANDALONE_BUDGET) continue;
    groupComponentsUsed = g;
    standaloneComponentsUsed = s;
    parent[ra] = rb;
    rootKeyCount[rb] = rootKeyCount[ra] + rootKeyCount[rb];
    rootHasGroup[rb] = resultHasGroup;
    rootMerged[rb] = true;
  }

  // --- Collect components with >= 2 units.
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < units.length; i++) {
    const r = find(i);
    const arr = byRoot.get(r) ?? [];
    arr.push(i);
    byRoot.set(r, arr);
  }
  const result: SameEventMergeResult = { ...empty, mustLinkGroups: [] };
  const componentsOut: string[][] = [];
  for (const idxs of Array.from(byRoot.values())) {
    if (idxs.length < 2) continue;
    const members = idxs.map(i => units[i]);
    const groupUnits = members.filter(m => m.isGroup).length;
    if (groupUnits === 0) {
      // Standalone-only components keep the fuzzy lane's >= 2 distinct
      // publishers requirement (a single outlet's near-dupes never form).
      const pubs = new Set(members.flatMap(m => m.corr.map(publisherKeyOf)));
      if (pubs.size < MIN_CONTRIBUTING_TO_FORM) continue;
      result.standaloneComponents++;
    } else if (groupUnits === 1) {
      result.foldComponents++;
    } else {
      result.crossGroupComponents++;
    }
    componentsOut.push(Array.from(new Set(members.flatMap(m => m.keys))).sort());
  }
  componentsOut.sort((a, b) => ((a[0] ?? '') < (b[0] ?? '') ? -1 : (a[0] ?? '') > (b[0] ?? '') ? 1 : 0));
  result.mustLinkGroups = componentsOut;
  return result;
}

// Canonical normalized title used as the must-link grouping key. Prefers the
// stored normalized_title (the same dedup key the ingest pipeline computes) and
// falls back to normalizeTitle(title) for carried/legacy nodes and test fixtures
// that don't carry it. Returns '' when there is nothing to key on.
export function deterministicTitleKey(
  node: Pick<LaneNode, 'title'> & { normalizedTitle?: string | null },
): string {
  const stored = (node.normalizedTitle ?? '').trim();
  if (stored) return stored;
  return normalizeTitle(node.title ?? '').trim();
}

// Minimum significant title tokens for an identical-title group to qualify. Guards
// against must-linking on a trivially short / generic shared headline (e.g. a
// one-word "Update"); a real syndicated story headline has many more.
const IDENTICAL_TITLE_MIN_TOKENS = 4;

// True when every node with a known timestamp falls within one same-event window
// of the others. Identical wording from a DIFFERENT news cycle (a recurring
// column / re-used headline days apart) must NOT be must-linked. Fewer than two
// known timestamps is permissive (matches withinSameEventWindow's missing-time
// fallback) so a story is never dropped purely for missing publish times.
function allWithinSameEventWindow(nodes: LaneNode[]): boolean {
  const times = nodes
    .map(n => (n.publishedAt ? new Date(n.publishedAt).getTime() : NaN))
    .filter(t => Number.isFinite(t)) as number[];
  if (times.length < 2) return true;
  return (Math.max(...times) - Math.min(...times)) / 3_600_000 <= SAME_EVENT_WINDOW_HOURS;
}

// Group nodes that MUST co-cluster: the EXACT same normalized title, >= 2
// CORROBORATING members from >= 2 DISTINCT publishers, all within the same-event
// window, and a non-trivial headline. Returns one array per qualifying title
// (every node sharing that exact title, including any attach/anchor copies — they
// are the same article so they ride along; the formation gate still counts only
// corroborating). Pure + deterministic. Used both for CANDIDACY (guarantee both
// twins enter the payload) and at FORMATION (force the merge after LLM grouping).
export function buildIdenticalTitleMustLinkGroups(nodes: LaneNode[]): LaneNode[][] {
  const byTitle = new Map<string, LaneNode[]>();
  for (const n of nodes) {
    const key = deterministicTitleKey(n);
    if (!key) continue;
    if (significantTitleTokens(n.title).size < IDENTICAL_TITLE_MIN_TOKENS) continue;
    const arr = byTitle.get(key);
    if (arr) arr.push(n);
    else byTitle.set(key, [n]);
  }
  const groups: LaneNode[][] = [];
  for (const arr of Array.from(byTitle.values())) {
    if (arr.length < 2) continue;
    const corroborating = arr.filter(n => n.cls === 'corroborating');
    if (corroborating.length < MIN_CONTRIBUTING_TO_FORM) continue;
    const distinctPublishers = new Set(corroborating.map(publisherKeyOf));
    if (distinctPublishers.size < MIN_CONTRIBUTING_TO_FORM) continue;
    if (!allWithinSameEventWindow(corroborating)) continue;
    groups.push(arr);
  }
  return groups;
}

// Reconcile deterministic must-link groups into the LLM's (coherence-pruned)
// grouping so every must-link group ends up wholly inside ONE final group. For
// each must-link set, union together every existing group it touches AND all its
// mates; a must-link set that no group touches becomes its own new group. The
// result then flows through the existing orderedGroups + assignedKeys cross-group
// dedup and the UNCHANGED formation gate, so this only MERGES obvious duplicates —
// it never stands up a story the gate wouldn't otherwise allow. Pure + deterministic.
export function reconcileMustLinkGroups(
  coherentGroups: ClusterGroup[],
  mustLinkKeyGroups: string[][],
): ClusterGroup[] {
  const groups: Set<string>[] = coherentGroups.map(g => new Set(g.keys));
  for (const link of mustLinkKeyGroups) {
    if (link.length < 2) continue;
    const touched: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      if (link.some(k => groups[i].has(k))) touched.push(i);
    }
    if (touched.length === 0) {
      groups.push(new Set(link));
      continue;
    }
    const target = groups[touched[0]];
    for (let t = 1; t < touched.length; t++) {
      for (const k of Array.from(groups[touched[t]])) target.add(k);
    }
    for (const k of link) target.add(k);
    for (let t = touched.length - 1; t >= 1; t--) groups.splice(touched[t], 1);
  }
  return groups.map(s => ({ keys: Array.from(s) }));
}

// Approved learned outlet-pair rules are recall AFFINITIES, not authoritative
// human must-links. Apply them against the ORIGINAL coherent grouping so they may:
//   - pair two ungrouped nodes when that pairing is unambiguous; or
//   - fold an ungrouped node into one existing coherent group.
// They may NEVER fuse two existing groups. Candidate degree also rejects ambiguous
// cross-products (for example, two same-cycle stories from each learned outlet),
// preventing sequential pair application from chaining those stories together.
// Pure + deterministic; the caller has already applied category/time/event gates.
export function reconcileLearnedAffinityGroups(
  coherentGroups: ClusterGroup[],
  learnedPairGroups: string[][],
): ClusterGroup[] {
  const groups: Set<string>[] = coherentGroups.map(g => new Set(g.keys));
  const originalGroupByKey = new Map<string, number>();
  coherentGroups.forEach((group, index) => {
    for (const key of group.keys) {
      if (!originalGroupByKey.has(key)) originalGroupByKey.set(key, index);
    }
  });

  const pairs = learnedPairGroups
    .map(link => Array.from(new Set(link)).slice(0, 2))
    .filter(link => link.length === 2 && link[0] !== link[1]);
  const candidateDegree = new Map<string, number>();
  for (const [left, right] of pairs) {
    candidateDegree.set(left, (candidateDegree.get(left) ?? 0) + 1);
    candidateDegree.set(right, (candidateDegree.get(right) ?? 0) + 1);
  }

  for (const [left, right] of pairs) {
    const leftGroup = originalGroupByKey.get(left);
    const rightGroup = originalGroupByKey.get(right);
    const isUnambiguous =
      candidateDegree.get(left) === 1 &&
      candidateDegree.get(right) === 1;

    // Already coherent needs no learned intervention; two different coherent
    // groups are never fused by a learned outlet-level rule.
    if (leftGroup !== undefined && rightGroup !== undefined) continue;
    if (!isUnambiguous) continue;

    if (leftGroup === undefined && rightGroup === undefined) {
      groups.push(new Set([left, right]));
      continue;
    }

    const groupedIndex = leftGroup ?? rightGroup;
    const standaloneKey = leftGroup === undefined ? left : right;
    if (groupedIndex === undefined) continue;
    groups[groupedIndex].add(standaloneKey);
  }

  return groups.map(s => ({ keys: Array.from(s) }));
}

// ---------------------------------------------------------------------------
// EDITOR manual-MERGE consolidation (curated-only). OVERLAPPING active merge
// rows must act as ONE authoritative story — never compete for members. The
// carve-out below builds one dedicated forced group per merge row and lets the
// first group claim shared keys (Phase A assignedKeys), so two overlapping
// merges PARTITION their members: a retry merge saved over a subset of an
// earlier merge's items splits the story into two clusters, and the leftover
// fragment then drags unrelated members in via story-sticky expansion. Every
// retry makes it worse — the exact opposite of the editor's intent.
//
// This helper unions the forced-merge key groups into connected components
// before the carve-out:
//   - Merge rows sharing >= 1 present key collapse into one forced group
//     (transitive: A∪B, B∪C → A∪B∪C — they are all the same human story).
//   - A soft "link" row that intersects a merge component pulls its OWN
//     present keys into that component too (and a link spanning TWO merge
//     components unions them): the editor's later "link these together"
//     attempt must strengthen the earlier merge, not lose to it when the
//     carve-out yanks merge members back out of the reconciled group.
//     SINGLE HOP, fail-closed: a link only joins via keys shared with the RAW
//     merge key set — links can never chain link-to-link into a merge, and a
//     link touching no merge stays soft (formation gate fully in force).
// Pure + deterministic (sorted keys / components), exported for the gate.
export function consolidateForcedMergeGroups(
  mergeKeyGroups: string[][],
  softLinkKeyGroups: string[][] = [],
): string[][] {
  const groups: Array<Set<string>> = [];
  const mergeKeys = new Set<string>(mergeKeyGroups.flat());
  const absorb = (link: string[]) => {
    const touched: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      if (link.some(k => groups[i].has(k))) touched.push(i);
    }
    if (touched.length === 0) return false;
    const target = groups[touched[0]];
    for (let t = 1; t < touched.length; t++) {
      for (const k of groups[touched[t]]) target.add(k);
    }
    for (const k of link) target.add(k);
    for (let t = touched.length - 1; t >= 1; t--) groups.splice(touched[t], 1);
    return true;
  };
  for (const mg of mergeKeyGroups) {
    if (mg.length < 2) continue;
    if (!absorb(mg)) groups.push(new Set(mg));
  }
  for (const lg of softLinkKeyGroups) {
    if (lg.length < 2) continue;
    // Single hop: only links sharing a key with the RAW merge key set join.
    if (!lg.some(k => mergeKeys.has(k))) continue;
    absorb(lg);
  }
  return groups
    .map(s => Array.from(s).sort())
    .sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
}

// ---------------------------------------------------------------------------
// EDITOR manual-EVICTION application (curated-only) — the mirror image of the
// manual-link reconcile above. An eviction is a human's decision that ONE
// article was WRONGLY clustered into a story and must be pulled out. It is
// saved as (evictedUrl, anchorUrls[] = snapshot of the sibling member URLs on
// screen at click time). This helper runs on the ALREADY-reconciled groups and
// removes the evicted key from the group it landed in — but ONLY when that
// group is still substantially the same wrongly-merged cluster the editor was
// looking at (anchor guard). The evicted key then falls back to its own
// standalone group so it is NEVER lost from the lane.
//
// Over-eviction guards (fail-closed — an eviction must never dissolve an
// unrelated cluster or silently drop a member):
//   - Require >= 2 of the snapshot anchor URLs to still resolve to present
//     nodes: a single stray anchor cannot identify a cluster.
//   - The evicted key is removed ONLY from a group that still contains
//     >= max(2, ceil(10% of the snapshot anchor count)) of those anchors
//     (or >= 1 for a small snapshot of <= 5). If the evicted item churned into
//     a DIFFERENT cluster since the snapshot, the anchors won't be there and
//     the eviction NO-OPS (the editor can re-evict against the new cluster).
//   - The evicted key is always re-added as a singleton group, so removal can
//     only ever DEMOTE it to standalone, never delete it.
// Pure + deterministic, exported for the gate.
export interface ManualEvictionResolved {
  evictedKey: string;          // present node key of the wrongly-merged item
  anchorKeys: Set<string>;     // effective sibling anchors that resolve to keys (snapshot ∪ story-sticky expansion)
  storedAnchorCount: number;   // total snapshot anchor URLs (present or aged out)
  // True when the anchor set was WIDENED by story-sticky expansion this pass.
  // The guard in applyManualEvictions then scales `required` off the EFFECTIVE
  // set size (never the small snapshot count) so a handful of adopted URLs
  // shared with an unrelated group can never fire the eviction there.
  expanded: boolean;
}
export interface ManualEvictionResult {
  groups: ClusterGroup[];
  evictedKeys: Set<string>;    // keys actually evicted this pass (downstream excludes)
  applied: number;
}
export function applyManualEvictions(
  groups: ClusterGroup[],
  evictions: ManualEvictionResolved[],
  // RAW editor manual-link key groups (>= 2 present members each). PRECEDENCE
  // GUARD: an eviction is SKIPPED when an active manual link both contains the
  // evicted key AND shares >= 1 other key with the group under evaluation — the
  // editor's (newer) link intent beats an older eviction. The endpoints revoke
  // conflicting links at write time, so a genuine later unlink always wins.
  // RAW groups only (never the story-sticky expanded ones) so a machine-widened
  // set can never shield a cluster from a legitimate eviction.
  manualLinkKeyGroups: string[][] = [],
): ManualEvictionResult {
  const evictedKeys = new Set<string>();
  let applied = 0;
  const working: Set<string>[] = groups.map(g => new Set(g.keys));
  for (const ev of evictions) {
    if (!ev.evictedKey) continue;
    // Need at least two resolvable sibling anchors to trust that we found the
    // right cluster (a lone anchor is too weak to identify one).
    if (ev.anchorKeys.size < 2) continue;
    const gi = working.findIndex(s => s.has(ev.evictedKey));
    if (gi < 0) continue; // aged out or already standalone -> no-op
    const group = working[gi];
    // Manual-link precedence: the editor explicitly linked this item to at
    // least one other member of THIS group — the link wins, eviction no-ops.
    const linkHolds = manualLinkKeyGroups.some(
      g =>
        g.includes(ev.evictedKey) &&
        g.some(k => k !== ev.evictedKey && group.has(k)),
    );
    if (linkHolds) continue;
    let anchorsInGroup = 0;
    for (const ak of ev.anchorKeys) {
      if (ak !== ev.evictedKey && group.has(ak)) anchorsInGroup++;
    }
    // Guard fraction. For a raw snapshot the legacy rule holds (small snapshot
    // -> 1 anchor suffices; bigger -> 10%). For a story-sticky EXPANDED anchor
    // set the requirement scales off the EFFECTIVE set size instead — a couple
    // of adopted URLs that churned into an UNRELATED group must never fire the
    // eviction there (fail-closed, mirrors the manual-link expansion guards).
    const required = ev.expanded
      ? Math.max(2, Math.ceil(0.10 * ev.anchorKeys.size))
      : (() => {
          const stored = Math.max(ev.storedAnchorCount, ev.anchorKeys.size);
          return stored <= 5 ? 1 : Math.max(2, Math.ceil(0.10 * stored));
        })();
    if (anchorsInGroup < required) continue; // not the same cluster -> fail-closed
    group.delete(ev.evictedKey);
    evictedKeys.add(ev.evictedKey);
    applied++;
  }
  const out: ClusterGroup[] = working
    .filter(s => s.size > 0)
    .map(s => ({ keys: Array.from(s) }));
  // Never lose the evicted item — re-seed it as a standalone node. The formation
  // gate keeps a singleton standalone; it can only be re-clustered if the editor
  // later manually links it, never automatically back into the evicted cluster.
  for (const k of evictedKeys) {
    if (!out.some(g => g.keys.includes(k))) out.push({ keys: [k] });
  }
  return { groups: out, evictedKeys, applied };
}

// ---------------------------------------------------------------------------
// EDITOR manual-MOVE application (curated-only) — an atomic "this article
// belongs in that OTHER story": evict from the source cluster AND attach to
// the target cluster in ONE decision. A dedicated overlay (NOT an eviction +
// link composite) because reconcileMustLinkGroups runs BEFORE
// applyManualEvictions each pass — a link naming the item plus target members
// would FUSE the source and target clusters before the eviction could pull
// the item out. This helper runs AFTER applyManualEvictions on its output.
//
// Per move (fail-closed, deterministic):
//   - Skip if the item is not present this pass (aged out -> no-op).
//   - IDEMPOTENT: skip if the item's current group already holds enough
//     target anchors (it is already home).
//   - Manual-link precedence: an active RAW link containing the item that
//     shares >= 1 other key with the item's current group wins — skip.
//   - Re-home requires >= 2 resolvable target anchors AND a target group that
//     clears the same anchor-guard shape as evictions (expanded -> scale off
//     the effective set; raw small snapshot <= 5 -> 1; else 10%).
//   - Extraction from a MULTI-member source group needs the source-side
//     anchor guard to confirm it is still the cluster the editor saw
//     (relaxed: >= 1 resolvable source anchor when a valid target exists —
//     the target confirms intent). A singleton source is always extractable.
//   - If NO valid target group survives churn, degrade to a plain EVICTION
//     ONLY when the eviction-grade gate holds (>= 2 resolvable source
//     anchors + guard); the item is then re-seeded standalone and reported
//     in evictedKeys. Genuinely MOVED keys are NOT in evictedKeys — they may
//     keep riding their new story (semantic attach etc.).
// Pure + deterministic, exported for the gate.
export interface ManualMoveResolved {
  itemKey: string;             // present node key of the article being moved
  sourceAnchorKeys: Set<string>;  // effective source-sibling anchors (snapshot ∪ expansion)
  sourceStoredCount: number;   // total stored source anchor URLs
  sourceExpanded: boolean;     // source set widened by story-sticky expansion
  targetAnchorKeys: Set<string>;  // effective target-member anchors (snapshot ∪ expansion)
  targetStoredCount: number;   // total stored target anchor URLs
  targetExpanded: boolean;     // target set widened by story-sticky expansion
}
export interface ManualMoveResult {
  groups: ClusterGroup[];
  movedKeys: Set<string>;      // keys re-homed into their target this pass
  evictedKeys: Set<string>;    // degraded-to-eviction keys (downstream excludes)
  applied: number;             // moves that changed the grouping (moved + degraded)
}
export function applyManualMoves(
  groups: ClusterGroup[],
  moves: ManualMoveResolved[],
  // RAW editor manual-link key groups — same precedence guard as evictions:
  // a link that holds the item inside its CURRENT group beats an older move.
  manualLinkKeyGroups: string[][] = [],
): ManualMoveResult {
  const movedKeys = new Set<string>();
  const evictedKeys = new Set<string>();
  let applied = 0;
  const working: Set<string>[] = groups.map(g => new Set(g.keys));
  // Same guard shape as applyManualEvictions.
  const guardRequired = (anchorKeys: Set<string>, storedCount: number, expanded: boolean): number =>
    expanded
      ? Math.max(2, Math.ceil(0.10 * anchorKeys.size))
      : (() => {
          const stored = Math.max(storedCount, anchorKeys.size);
          return stored <= 5 ? 1 : Math.max(2, Math.ceil(0.10 * stored));
        })();
  for (const mv of moves) {
    if (!mv.itemKey) continue;
    const gi = working.findIndex(s => s.has(mv.itemKey));
    if (gi < 0) continue; // item aged out this pass -> no-op
    const group = working[gi];
    const targetRequired = guardRequired(mv.targetAnchorKeys, mv.targetStoredCount, mv.targetExpanded);
    // IDEMPOTENCE: already sitting with enough target anchors -> nothing to do.
    let targetInCurrent = 0;
    for (const tk of mv.targetAnchorKeys) {
      if (tk !== mv.itemKey && group.has(tk)) targetInCurrent++;
    }
    if (targetInCurrent >= targetRequired && mv.targetAnchorKeys.size >= 2) continue;
    // Manual-link precedence: an active raw link holds the item in THIS group.
    const linkHolds = manualLinkKeyGroups.some(
      g =>
        g.includes(mv.itemKey) &&
        g.some(k => k !== mv.itemKey && group.has(k)),
    );
    if (linkHolds) continue;
    // Find the best target group (exclude the item's own group). A target must
    // clear the guard; deterministic tie-breaks: most anchors, then smaller
    // group, then lexicographically-smallest member key.
    let target: { idx: number; anchors: number; size: number; minKey: string } | null = null;
    if (mv.targetAnchorKeys.size >= 2) {
      for (let j = 0; j < working.length; j++) {
        if (j === gi) continue;
        const cand = working[j];
        let anchors = 0;
        for (const tk of mv.targetAnchorKeys) {
          if (tk !== mv.itemKey && cand.has(tk)) anchors++;
        }
        if (anchors < targetRequired || anchors < 1) continue;
        let minKey = '';
        for (const k of cand) if (minKey === '' || k < minKey) minKey = k;
        const better =
          !target ||
          anchors > target.anchors ||
          (anchors === target.anchors && cand.size < target.size) ||
          (anchors === target.anchors && cand.size === target.size && minKey < target.minKey);
        if (better) target = { idx: j, anchors, size: cand.size, minKey };
      }
    }
    // Source-side extraction guard.
    const isSingleton = group.size === 1;
    let srcInGroup = 0;
    for (const sk of mv.sourceAnchorKeys) {
      if (sk !== mv.itemKey && group.has(sk)) srcInGroup++;
    }
    const srcRequired = guardRequired(mv.sourceAnchorKeys, mv.sourceStoredCount, mv.sourceExpanded);
    if (target) {
      // RE-HOME. A singleton source is always extractable (it is already
      // standalone — the move just attaches it to its target). A multi-member
      // source must clear the source-anchor guard so churn into an UNRELATED
      // cluster can never rip the item out of the wrong story.
      const extractable = isSingleton || (srcInGroup >= 1 && srcInGroup >= srcRequired);
      if (!extractable) continue;
      group.delete(mv.itemKey);
      working[target.idx].add(mv.itemKey);
      movedKeys.add(mv.itemKey);
      applied++;
    } else {
      // DEGRADE to plain eviction — eviction-grade gate only (>= 2 resolvable
      // source anchors + full guard), never from a singleton (already standalone).
      if (isSingleton) continue;
      if (mv.sourceAnchorKeys.size < 2) continue;
      if (srcInGroup < srcRequired) continue;
      group.delete(mv.itemKey);
      evictedKeys.add(mv.itemKey);
      applied++;
    }
  }
  const out: ClusterGroup[] = working
    .filter(s => s.size > 0)
    .map(s => ({ keys: Array.from(s) }));
  // Never lose a degraded-eviction item — re-seed it standalone (mirrors
  // applyManualEvictions). Moved keys live in their target group already.
  for (const k of evictedKeys) {
    if (!out.some(g => g.keys.includes(k))) out.push({ keys: [k] });
  }
  return { groups: out, movedKeys, evictedKeys, applied };
}

// ---------------------------------------------------------------------------
// STORY-STICKY editor manual-link expansion (curated-only). A manual link is
// saved as a snapshot of the article URLs on screen at click time, but cluster
// membership churns every pass (live pages swap for article pages, new
// same-event URLs arrive, old ones age out). A URL-frozen link therefore loses
// its grip: the duplicate story it was meant to fold in can re-form from URLs
// the link never named. This helper, recomputed fresh each pass (NOTHING is
// persisted — revoking the link remains a clean off-switch), expands each
// link's effective URL set with the CURRENT members of any surviving prior
// cluster the link still anchors, so the link keeps holding those stories'
// present-day members together as the underlying URLs rotate.
//
// Over-merge guards (fail-closed — the #1 curated invariant):
//   - A cluster is "anchored" only when it contains >= max(2, 10% of its
//     members) linked URLs, or >= 1 for a small (<= 5 member) cluster. A lone
//     stray URL that churned into an unrelated 100-member megacluster can
//     NEVER drag that megacluster into the editor's story.
//   - At most MANUAL_LINK_MAX_ANCHORED_CLUSTERS clusters expand one link, and
//     the effective URL set is capped at MANUAL_LINK_EFFECTIVE_URL_CAP (raw
//     snapshot URLs are seeded first, so the cap can only ever trim expansion).
//   - Single hop, NO transitivity: anchors are computed from the RAW snapshot
//     URLs only — machine-added URLs never recruit further clusters.
// The expanded groups feed ONLY reconcileMustLinkGroups (the merge step). The
// protection sets (manualLinkProtectedKeys — false-merge dissolution +
// anchor-split exemptions) and applySplitOverlays stay on the RAW snapshot so
// a per-pass machine-inferred set can never exempt an anchored megacluster
// from those safety backstops. Pure + deterministic, exported for the gate.
export interface PriorClusterUrls {
  urls: Set<string>; // normalized member URLs of one surviving prior cluster
  size: number;      // its member count
}
// Per-URL metadata (title tokens + published time) for the coherence filter on
// story-sticky adoption, keyed by the same normalized member URL as
// PriorClusterUrls.urls. Built by the caller from the persisted prior-cluster
// members (which carry title + publishedAt).
export interface ManualLinkUrlMeta {
  titleTokens: Set<string>;
  publishedAt: Date | string | null;
}
export interface ManualLinkExpansion {
  urls: Set<string>; // raw snapshot URLs ∪ anchored clusters' current URLs
  addedUrls: number;
  anchoredClusters: number;
}
export const MANUAL_LINK_MAX_ANCHORED_CLUSTERS = 3;
export const MANUAL_LINK_EFFECTIVE_URL_CAP = 200;
// Per-link cap on the number of URLs ADDED by story-sticky expansion (Task #1025).
// The raw snapshot URLs are always fully seeded (the link itself always applies).
// Story-sticky expansion can adopt URLs from up to MANUAL_LINK_MAX_ANCHORED_CLUSTERS
// surviving clusters, but if those clusters are large, the adopted URLs can balloon —
// a single link pulled in +63 expansion URLs and contributed to a 72-member over-merged
// cluster. This bounds the ADDED expansion (beyond the raw snapshot) per link per pass
// so one editor link cannot grow a cluster by dozens of extra URLs; editor intent is
// preserved (the raw snapshot link still always applies). Curated-lane only.
export const MANUAL_LINK_EXPANSION_ADDED_CAP = 30;

export function expandManualLinkGroups(
  linkUrlSets: Array<Set<string>>,
  priorClusters: PriorClusterUrls[],
  urlMeta: Map<string, ManualLinkUrlMeta>,
): ManualLinkExpansion[] {
  return linkUrlSets.map(rawUrls => {
    const effective = new Set(rawUrls);
    if (rawUrls.size === 0) return { urls: effective, addedUrls: 0, anchoredClusters: 0 };
    // Per-URL COHERENCE FILTER on adoption (over-merge fix). An anchored prior
    // cluster can itself be a contaminated megacluster (prod: an editor's
    // 14-URL strikes link anchored a mixed house-vote+tanker+strikes cluster
    // and re-adopted its contaminated members every pass, re-gluing what the
    // LLM/coherence-guard/anchor-split had just separated — once mixed, always
    // mixed). So expansion no longer adopts a cluster's membership wholesale:
    // a member URL is adopted ONLY if it is titlesHighlySimilar to at least
    // one RAW snapshot member's title AND falls within the same-event time
    // window of that snapshot member. Fail-closed: a URL with no metadata (or
    // a link whose snapshot has no surviving metadata) is NOT adopted. The
    // editor's raw snapshot URLs always still apply unconditionally — only the
    // machine-inferred expansion is filtered.
    const rawMetas: ManualLinkUrlMeta[] = [];
    for (const ru of Array.from(rawUrls)) {
      const rm = urlMeta.get(ru);
      if (rm && rm.titleTokens.size > 0) rawMetas.push(rm);
    }
    const coherentWithSnapshot = (u: string): boolean => {
      const cand = urlMeta.get(u);
      if (!cand || cand.titleTokens.size === 0) return false;
      for (const rm of rawMetas) {
        if (
          titlesHighlySimilar(cand.titleTokens, rm.titleTokens) &&
          withinSameEventWindow(cand.publishedAt, rm.publishedAt)
        ) return true;
      }
      return false;
    };
    const candidates: Array<{ cluster: PriorClusterUrls; anchors: number; minUrl: string }> = [];
    for (const cluster of priorClusters) {
      if (cluster.size <= 0 || cluster.urls.size === 0) continue;
      let anchors = 0;
      for (const u of rawUrls) if (cluster.urls.has(u)) anchors++;
      if (anchors === 0) continue;
      const anchored =
        anchors >= Math.max(2, Math.ceil(0.10 * cluster.size)) ||
        (cluster.size <= 5 && anchors >= 1);
      if (!anchored) continue;
      let minUrl = '';
      for (const u of cluster.urls) if (minUrl === '' || u < minUrl) minUrl = u;
      candidates.push({ cluster, anchors, minUrl });
    }
    // Deterministic order: strongest anchor first, then smaller cluster, then URL.
    candidates.sort((a, b) =>
      b.anchors - a.anchors || a.cluster.size - b.cluster.size || a.minUrl.localeCompare(b.minUrl),
    );
    let added = 0;
    let anchoredCount = 0;
    for (const cand of candidates.slice(0, MANUAL_LINK_MAX_ANCHORED_CLUSTERS)) {
      let contributed = 0;
      const sorted = Array.from(cand.cluster.urls).sort();
      for (const u of sorted) {
        if (effective.size >= MANUAL_LINK_EFFECTIVE_URL_CAP) break;
        // Per-link expansion URL cap (Task #1025): bounds how many URLs story-sticky
        // can ADD beyond the raw snapshot so one editor link cannot balloon a cluster
        // by dozens of extra URLs from large prior-cluster memberships.
        if (added >= MANUAL_LINK_EXPANSION_ADDED_CAP) break;
        if (!effective.has(u)) {
          // Coherence filter (see above): adopt only same-event churn, never
          // an anchored megacluster's off-event contamination.
          if (!coherentWithSnapshot(u)) continue;
          effective.add(u);
          added++;
          contributed++;
        }
      }
      // Count a cluster as anchored only when it actually contributed at least
      // one URL (a cap-starved or fully-overlapping cluster changes nothing),
      // so the "via M anchored cluster(s)" log stays truthful.
      if (contributed > 0) anchoredCount++;
    }
    return { urls: effective, addedUrls: added, anchoredClusters: anchoredCount };
  });
}

// ---------------------------------------------------------------------------
// STORY-STICKY manual-EVICTION anchor expansion (curated-only) — the mirror of
// expandManualLinkGroups for the eviction overlay. An eviction is saved as the
// evicted URL + a snapshot of its sibling URLs at click time, but an ACTIVE
// cluster churns membership every pass (live pages swap for article pages, the
// rolling window sheds old members), so the snapshot anchors age out and the
// eviction silently no-ops — the LLM then re-absorbs the item the editor just
// removed. Recomputed fresh each pass (NOTHING persisted — revoking stays a
// clean off-switch; priorClusters come from the persisted member table so the
// hand-over-hand chain survives restarts), this widens each eviction's
// EFFECTIVE anchor set with the current members of any surviving prior cluster
// the RAW snapshot still anchors, so the eviction keeps its grip on the story
// as the underlying URLs rotate.
//
// Fail-closed guards (mirroring the manual-link expansion):
//   - Anchoring is computed from the RAW snapshot URLs only (single hop, no
//     transitivity) — adopted URLs never recruit further clusters.
//   - A cluster is "anchored" only when it holds >= max(2, 10% of its members)
//     snapshot anchors, or >= 1 for a small (<= 5 member) cluster.
//   - The evicted URL itself NEVER counts as an anchor and is never adopted.
//   - Caps: MANUAL_LINK_MAX_ANCHORED_CLUSTERS clusters, effective set size
//     MANUAL_LINK_EFFECTIVE_URL_CAP (snapshot seeded first).
//   - applyManualEvictions scales its required-overlap guard off the EFFECTIVE
//     set size whenever expansion added URLs (see `expanded`), so a few adopted
//     URLs shared with an unrelated group can never fire the eviction there.
// Pure + deterministic, exported for the gate.
export interface ManualEvictionExpansion {
  urls: Set<string>;   // snapshot anchor URLs ∪ anchored clusters' current URLs (minus evicted URL)
  addedUrls: number;
  anchoredClusters: number;
}

export function expandManualEvictionAnchors(
  evictions: Array<{ evictedUrl: string; anchorUrls: Set<string> }>,
  priorClusters: PriorClusterUrls[],
): ManualEvictionExpansion[] {
  return evictions.map(({ evictedUrl, anchorUrls }) => {
    const rawAnchors = new Set<string>();
    for (const u of Array.from(anchorUrls)) if (u && u !== evictedUrl) rawAnchors.add(u);
    const effective = new Set(rawAnchors);
    if (rawAnchors.size === 0) return { urls: effective, addedUrls: 0, anchoredClusters: 0 };
    const candidates: Array<{ cluster: PriorClusterUrls; anchors: number; minUrl: string }> = [];
    for (const cluster of priorClusters) {
      if (cluster.size <= 0 || cluster.urls.size === 0) continue;
      let anchors = 0;
      for (const u of Array.from(rawAnchors)) if (cluster.urls.has(u)) anchors++;
      if (anchors === 0) continue;
      const anchored =
        anchors >= Math.max(2, Math.ceil(0.10 * cluster.size)) ||
        (cluster.size <= 5 && anchors >= 1);
      if (!anchored) continue;
      let minUrl = '';
      for (const u of Array.from(cluster.urls)) if (minUrl === '' || u < minUrl) minUrl = u;
      candidates.push({ cluster, anchors, minUrl });
    }
    candidates.sort((a, b) =>
      b.anchors - a.anchors || a.cluster.size - b.cluster.size || a.minUrl.localeCompare(b.minUrl),
    );
    let added = 0;
    let anchoredCount = 0;
    for (const cand of candidates.slice(0, MANUAL_LINK_MAX_ANCHORED_CLUSTERS)) {
      let contributed = 0;
      const sorted = Array.from(cand.cluster.urls).sort();
      for (const u of sorted) {
        if (effective.size >= MANUAL_LINK_EFFECTIVE_URL_CAP) break;
        if (u === evictedUrl) continue; // the evicted item is never its own anchor
        if (!effective.has(u)) {
          effective.add(u);
          added++;
          contributed++;
        }
      }
      if (contributed > 0) anchoredCount++;
    }
    return { urls: effective, addedUrls: added, anchoredClusters: anchoredCount };
  });
}

export interface CandidateSelection {
  allNodes: LaneNode[];
  primaryCount: number;
  rescuedActiveOrNearDup: number; // continuity (a/a2) + near-dup (b), kept combined for gate compat
  rescuedNearDup: number; // near-dup lane (b) alone (own budget since the starvation fix)
  rescuedArchiveGrace: number;
  rescuedEventBucket: number;
  rescuedIdenticalTitle: number;
  rescuedSocial: number;
  rescuedContrast: number;
  rescuedManualLink: number;
  overflowCount: number;
  // Trust/volume observability for the PRIMARY cut (Task #311).
  primaryAdversary: number; // adversary/attach nodes admitted into the primary cut
  primaryContributing: number; // contributing/primary-anchor nodes in the primary cut
  deferredAdversary: number; // adversary/attach nodes pushed to overflow by the cap
}

// Pure candidate selection (extracted for Task #199 so it is unit-testable at
// production-scale volume). Returns the HARD-bounded set of nodes sent to the
// clustering LLM:
//   - the top MAX_NODES by priority, PLUS
//   - (a) active-cluster members + (b) near-duplicates of the priority payload
//         — the original Task #178 rescues, bounded by RESCUE_BUDGET, and
//   - (c) WHOLE same-event buckets discovered over the FULL over-cap pool that
//         could clear the >=2-corroborating gate on their own — the Task #199 fix
//         for an entire mid-priority event living below the cutoff — bounded by
//         EVENT_BUCKET_BUDGET.
// The LLM + coherence guard still decide the final grouping; this only governs
// which candidates co-enter the same payload. Total never exceeds HARD_NODE_CEILING.
export function selectCandidateNodes(
  candidateNodes: LaneNode[],
  activeClusterMemberKeys: Set<string>,
  // Normalized URLs of every active-cluster member (Task #207). The curated store
  // clones the main feed, so the SAME article can flip between a main:<id> and a
  // curated:<id> key across passes; matching the active set by URL too keeps a
  // still-active story's member in the payload even after its key changes. Default
  // empty so existing 2-arg callers (and the unit harness) stay valid.
  activeClusterMemberUrls: Set<string> = new Set(),
  // Normalized URLs of CONTRIBUTING members of recently phased-out-but-still-fresh
  // archive stories (Part B). A live candidate matching one of these is rescued
  // into the payload via the bounded (a2) sub-lane so a transiently-missed story
  // can re-form. Default empty so existing callers / the unit harness stay valid.
  archiveGraceMemberUrls: Set<string> = new Set(),
  // Normalized identity URLs named by ACTIVE editor manual-links (curated-only —
  // the human must-link overlay). Any candidate whose URL is in this set is
  // rescued into the payload UNCONDITIONALLY so the editor-linked items always
  // co-enter and the formation-time must-link can actually merge them. Editor
  // links are few, so this is inherently bounded. Default empty so existing
  // callers / the unit harness stay valid.
  manualLinkMemberUrls: Set<string> = new Set(),
): CandidateSelection {
  const sorted = [...candidateNodes].sort((a, b) => b.priority - a.priority);

  // Trust-aware PRIMARY cut (Task #311). Walk the priority-sorted pool and admit
  // the top MAX_NODES, but cap how many adversary/attach-only items (contrast
  // state media + social + unknown attach) may occupy that cut at
  // PRIMARY_ADVERSARY_CAP. Adversary/attach nodes beyond the cap are DEFERRED to
  // the overflow (they re-enter via the contrast/social rescue lanes when they
  // relate to a real story), so the freed slots go to the next CONTRIBUTING /
  // primary-anchor items by priority. This biases the primary payload toward the
  // contributors that can actually SEED a story without changing the priority
  // ordering of what is admitted.
  const primaryNodes: LaneNode[] = [];
  const deferredAdversaryNodes: LaneNode[] = [];
  let admittedAdversary = 0; // cap counter — adversary admitted under the cap
  for (const n of sorted) {
    if (primaryNodes.length >= MAX_NODES) break;
    if (isAdversaryAttachNode(n)) {
      if (admittedAdversary >= PRIMARY_ADVERSARY_CAP) {
        deferredAdversaryNodes.push(n);
        continue;
      }
      admittedAdversary++;
    }
    primaryNodes.push(n);
  }
  // Backfill: a low-volume cycle can exhaust the contributing/anchor items (and
  // the capped adversary quota) before MAX_NODES is reached — top up from the
  // deferred adversary nodes (already priority desc) so the primary payload is
  // never left shorter than the flat top-MAX_NODES cut would have been.
  if (primaryNodes.length < MAX_NODES && deferredAdversaryNodes.length > 0) {
    const inPrimary = new Set(primaryNodes.map(n => n.key));
    for (const n of deferredAdversaryNodes) {
      if (primaryNodes.length >= MAX_NODES) break;
      if (inPrimary.has(n.key)) continue;
      primaryNodes.push(n);
      inPrimary.add(n.key);
    }
  }
  const primaryKeySet = new Set(primaryNodes.map(n => n.key));
  // Overflow keeps the priority-desc order (the rescue lanes below rely on it),
  // and includes adversary nodes deferred by the cap that were not backfilled.
  const overflowNodes = sorted.filter(n => !primaryKeySet.has(n.key));
  // Truthful counts from the FINAL primary array (backfill can re-admit deferred
  // adversary nodes, so the cap counter alone would undercount adversary).
  const primaryAdversary = primaryNodes.filter(isAdversaryAttachNode).length;
  const primaryContributing = primaryNodes.length - primaryAdversary;
  // Only nodes the CAP actually pushed out (and that backfill didn't re-admit) —
  // NOT every adversary node that naturally fell below the top-MAX_NODES cut by
  // priority. When adversary volume is under the cap this is 0.
  const deferredAdversary = deferredAdversaryNodes.filter(
    n => !primaryKeySet.has(n.key),
  ).length;

  if (overflowNodes.length === 0) {
    return {
      allNodes: primaryNodes,
      primaryCount: primaryNodes.length,
      rescuedActiveOrNearDup: 0,
      rescuedNearDup: 0,
      rescuedArchiveGrace: 0,
      rescuedEventBucket: 0,
      rescuedIdenticalTitle: 0,
      rescuedSocial: 0,
      rescuedContrast: 0,
      rescuedManualLink: 0,
      overflowCount: 0,
      primaryAdversary,
      primaryContributing,
      deferredAdversary,
    };
  }

  const selectedKeys = new Set(primaryNodes.map(n => n.key));
  const rescued: LaneNode[] = [];
  // Running total across the HEURISTIC rescue lanes (b)/(c0)/(c)/(d)/(e) only
  // (Task #1025, reworked). Enforces TOTAL_RESCUE_CEILING via the reserved-floor
  // arithmetic (see the constant's contract). Manual-link (m) and the continuity
  // lanes (a)/(a2) are exempt — they have their own bounds.
  let totalRescued = 0;

  // (m) editor manual-link rescue — curated-only. The editor deliberately named
  // these items as ONE story, so any that fell below the priority cut are pulled
  // into the payload UNCONDITIONALLY (no near-dup / event-window test), ensuring
  // both ends of a "link stray item -> story" and every member of a "merge" are
  // present for the formation-time must-link. Runs FIRST so an editor link is
  // never crowded out of the payload by the other bounded rescue lanes. Editor
  // links are a handful, so this is naturally bounded.
  let manualLinkRescued = 0;
  if (manualLinkMemberUrls.size > 0) {
    for (const n of overflowNodes) {
      if (selectedKeys.has(n.key)) continue;
      const nUrl = normalizeMemberUrl(n.url);
      if (nUrl && manualLinkMemberUrls.has(nUrl)) {
        rescued.push(n);
        selectedKeys.add(n.key);
        manualLinkRescued++;
      }
    }
    // The manual-link lane is the ONLY rescue path outside the normal payload
    // budgets. It is deliberately never truncated: dropping a linked member
    // changes an editor's explicit story decision and can split a later whole
    // event bucket below the formation gate. Warn when the expected headroom is
    // exceeded, but preserve the complete, bounded-by-editor overlay set.
    if (manualLinkRescued > MANUAL_LINK_HEADROOM) {
      console.warn(
        `[CuratedCluster] WARNING: manual-link rescues (${manualLinkRescued}) exceed ` +
          `MANUAL_LINK_HEADROOM (${MANUAL_LINK_HEADROOM}) — preserving all editor-linked ` +
          `members rather than truncating a story candidate. Review editor manual links.`,
      );
    }
  }

  // (a) active-cluster member + (a2) archive-grace member + (b) near-duplicate of
  // something already in the priority payload — Task #178 / #199 / #215. A
  // lower-priority row that belongs to an already-active/forming story, that is a
  // contributing member of a recently-missed-but-still-fresh archive story, or
  // whose title looks like the SAME event as something already selected, gets a
  // bounded second chance into the payload.
  //
  // Starvation fix: the CONTINUITY sub-lanes (a) + (a2) have their own
  // RESCUE_BUDGET and are EXEMPT from TOTAL_RESCUE_CEILING (see the constant's
  // contract) — at production volume they consumed the whole ceiling every pass,
  // permanently starving lanes (b)-(e) to 0. Near-dup (b) no longer scavenges
  // pass-1 leftovers; it has its own NEAR_DUP_RESCUE_BUDGET and is the FIRST
  // lane counted against the heuristic ceiling. Running near-dup second still
  // means a higher-priority near-dup can never crowd a still-active story's
  // lower-priority source out of the continuity budget (Task #215).
  // `primaryTokenSets` is derived from primaryNodes ONLY, so a pass-1 rescue never
  // becomes a new near-dup anchor (which would silently widen recall).
  const primaryTokenSets = primaryNodes.map(n => significantTitleTokens(n.title));
  let continuityRescued = 0;
  let nearDupRescued = 0;
  let archiveGraceRescued = 0;
  // Pass 1 (continuity, ceiling-EXEMPT): active-cluster members (a) and
  // archive-grace members (a2), priority-desc, until RESCUE_BUDGET is exhausted.
  for (const n of overflowNodes) {
    if (continuityRescued >= RESCUE_BUDGET) break;
    if (selectedKeys.has(n.key)) continue;
    const nUrl = normalizeMemberUrl(n.url);
    let matched = false;
    // Active-cluster member — matched by key OR by normalized URL (Task #207), so
    // an article whose key flipped (main:<id> <-> curated:<id>) across passes is
    // still recognized as belonging to the still-active story. Checked BEFORE
    // archive-grace so a node qualifying for both counts as active, not grace.
    if (activeClusterMemberKeys.has(n.key) || (nUrl && activeClusterMemberUrls.has(nUrl))) {
      matched = true;
    } else if (
      // (a2) archive-grace member — a CONTRIBUTING article of a recently-missed,
      // still-fresh story (Part B). Bounded by ARCHIVE_GRACE_ADMIT_MAX (a sub-cap
      // INSIDE the shared RESCUE_BUDGET). Incremented only on actual admission.
      archiveGraceRescued < ARCHIVE_GRACE_ADMIT_MAX &&
      nUrl &&
      archiveGraceMemberUrls.has(nUrl)
    ) {
      matched = true;
      archiveGraceRescued++;
    }
    if (matched) {
      rescued.push(n);
      selectedKeys.add(n.key);
      continuityRescued++;
    }
  }
  // Pass 2 — lane (b), near-dup of a priority-payload item: same wording AND
  // within the same-event time window of that specific item (so a same-title
  // report from a different news cycle isn't pulled in), priority-desc, bounded
  // by its own NEAR_DUP_RESCUE_BUDGET and by the ceiling minus the floors of the
  // lanes still to run. selectedKeys carries over from pass 1, so nothing is
  // admitted twice.
  //
  // Body-aware fallback (Task #747): if the title-only match fails but the
  // overflow node has body content (bullets or summary), try combined title+body
  // tokens against the primary payload's combined tokens. looksSameEvent's
  // precision bar is unchanged — only the token INPUTS widen. A false positive
  // here merely lets the LLM + coherence guard consider one extra candidate; they
  // make the final grouping decision, never this recall gate.
  const primaryCombinedTokenSets = primaryNodes.map(p => significantCandidateTokens(p));
  // Reserved-floor arithmetic: lane (b) runs FIRST against the heuristic ceiling,
  // so it may take at most its own budget while leaving every later lane's floor
  // intact (identical-title 40 + event-bucket 24 + social 8 + contrast 8 = 80).
  const nearDupCap = Math.min(
    NEAR_DUP_RESCUE_BUDGET,
    Math.max(
      0,
      TOTAL_RESCUE_CEILING - totalRescued -
        (IDENTICAL_TITLE_RESCUE_FLOOR + EVENT_BUCKET_RESCUE_FLOOR + SOCIAL_RESCUE_FLOOR + CONTRAST_RESCUE_FLOOR),
    ),
  );
  for (const n of overflowNodes) {
    if (nearDupRescued >= nearDupCap) break;
    if (selectedKeys.has(n.key)) continue;
    const toks = significantTitleTokens(n.title);
    if (
      toks.size >= 2 &&
      primaryNodes.some(
        (p, i) =>
          withinSameEventWindow(n.publishedAt, p.publishedAt) &&
          looksSameEvent(toks, primaryTokenSets[i]),
      )
    ) {
      rescued.push(n);
      selectedKeys.add(n.key);
      nearDupRescued++;
      totalRescued++;
      continue;
    }
    const combined = significantCandidateTokens(n);
    if (combined.size > toks.size) {
      const bodyMatched = primaryNodes.some(
        (p, i) =>
          withinSameEventWindow(n.publishedAt, p.publishedAt) &&
          looksSameEvent(combined, primaryCombinedTokenSets[i]),
      );
      if (bodyMatched) {
        rescued.push(n);
        selectedKeys.add(n.key);
        nearDupRescued++;
        totalRescued++;
      }
    }
  }

  // (c0) identical-title rescue — the candidacy half of the deterministic
  // must-link (curated syndication merge). Nodes that share the EXACT normalized
  // title from >= 2 distinct publishers are the same wire / syndicated article and
  // MUST co-cluster. The general same-event bucket lane (c) below can miss them:
  // its budget may be spent on other buckets first, and it only buckets the
  // OVER-CAP pool, so an identical-title twin of a node that already made the
  // primary cut is left a singleton and never rescued. Detect identical-title
  // groups over the FULL pool and admit any member not yet selected so BOTH twins
  // co-enter and the formation-time must-link can merge them. Uses its OWN
  // IDENTICAL_TITLE_RESCUE_BUDGET (separate from EVENT_BUCKET_BUDGET lane (c)) so
  // this CORRECTNESS guarantee can never be crowded out by recall heuristics on a
  // busy day. HARD_NODE_CEILING is updated to include this dedicated budget.
  let identicalTitleRescued = 0;
  // The identical-title floor equals its full budget (correctness guarantee), so
  // this cap is always the full IDENTICAL_TITLE_RESCUE_BUDGET in practice — the
  // near-dup lane can never eat into it.
  const identicalTitleCap = Math.min(
    IDENTICAL_TITLE_RESCUE_BUDGET,
    Math.max(
      0,
      TOTAL_RESCUE_CEILING - totalRescued -
        (EVENT_BUCKET_RESCUE_FLOOR + SOCIAL_RESCUE_FLOOR + CONTRAST_RESCUE_FLOOR),
    ),
  );
  for (const group of buildIdenticalTitleMustLinkGroups([...primaryNodes, ...overflowNodes])) {
    if (identicalTitleRescued >= identicalTitleCap) break;
    const missing = group.filter(n => !selectedKeys.has(n.key));
    if (missing.length === 0) continue; // whole group already in the payload
    if (identicalTitleRescued + missing.length > IDENTICAL_TITLE_RESCUE_BUDGET) continue;
    const admittable = Math.min(missing.length, identicalTitleCap - identicalTitleRescued);
    const toAdd = missing.slice(0, admittable);
    for (const n of toAdd) {
      rescued.push(n);
      selectedKeys.add(n.key);
    }
    identicalTitleRescued += toAdd.length;
    totalRescued += toAdd.length;
  }

  // (c) event-aware rescue (Task #199): bucket the WHOLE remaining over-cap pool
  // into same-event groups and admit, TOGETHER, any bucket that could clear the
  // >=2-corroborating formation gate on its own — i.e. an entire same-event group
  // living below the cutoff that nothing in the top window seeds. The whole bucket
  // (its corroborating seeds AND its attach-only/anchor members) is admitted or
  // skipped as a unit, so a story can actually form and its attach items have
  // something to join. Strongest events first; bounded by EVENT_BUCKET_BUDGET.
  const remainingOverflow = overflowNodes.filter(n => !selectedKeys.has(n.key));
  const eventBuckets = buildSameEventBuckets(remainingOverflow)
    .filter(
      b => b.filter(n => n.cls === 'corroborating').length >= MIN_CONTRIBUTING_TO_FORM,
    )
    .sort(
      (a, b) =>
        Math.max(...b.map(n => n.priority)) - Math.max(...a.map(n => n.priority)),
    );
  let eventBucketRescued = 0;
  // Guaranteed at least EVENT_BUCKET_RESCUE_FLOOR (24) slots even when the
  // earlier heuristic lanes saturated; can borrow up to EVENT_BUCKET_BUDGET when
  // they were quiet.
  const eventBucketCap = Math.min(
    EVENT_BUCKET_BUDGET,
    Math.max(0, TOTAL_RESCUE_CEILING - totalRescued - (SOCIAL_RESCUE_FLOOR + CONTRAST_RESCUE_FLOOR)),
  );
  for (const bucket of eventBuckets) {
    if (eventBucketRescued >= eventBucketCap) break;
    // Admit the bucket as a UNIT — a half-admitted bucket can't clear the >=2 gate
    // anyway. If a bucket can't fit the remaining budget, skip it and try a smaller
    // one rather than partially admitting it.
    if (eventBucketRescued + bucket.length > eventBucketCap) continue;
    for (const n of bucket) {
      rescued.push(n);
      selectedKeys.add(n.key);
    }
    eventBucketRescued += bucket.length;
    totalRescued += bucket.length;
  }

  // (d) social-flash rescue (Task #209): an official social post (X / Truth Social
  // / DataMinr) enters curated at a fixed low priority and its "title" is tweet
  // PROSE, so it almost always lands in the overflow AND rarely token-matches a
  // news headline strongly enough for lane (b). Give social-flash overflow nodes a
  // dedicated, bounded second chance to ride into the payload alongside the story
  // they cover. Match each against a SNAPSHOT of the real story nodes already
  // selected (corroborating or primary-origin anchors only — never another social
  // / attach node), using the RELAXED relatedness check (>= 2 shared significant
  // tokens) plus the same-event time window. overflowNodes is already priority
  // desc, so this admits the strongest social posts first. Social is attach-only —
  // the LLM grouping + coherence guard + >=2 formation gate still decide the final
  // attachment; this only ensures the candidate co-enters the same payload.
  const storyRefNodes = [...primaryNodes, ...rescued].filter(
    n => n.cls === 'corroborating' || (n.cls === 'anchor-only' && n.label === 'primary'),
  );
  const storyRefTokenSets = storyRefNodes.map(n => significantTitleTokens(n.title));
  let socialRescued = 0;
  // Guaranteed at least SOCIAL_RESCUE_FLOOR (8) slots even on a saturated pass.
  const socialCap = Math.min(
    SOCIAL_RESCUE_BUDGET,
    Math.max(0, TOTAL_RESCUE_CEILING - totalRescued - CONTRAST_RESCUE_FLOOR),
  );
  if (storyRefNodes.length > 0) {
    for (const n of overflowNodes) {
      if (socialRescued >= socialCap) break;
      if (selectedKeys.has(n.key)) continue;
      if (!n.isSocialFlash) continue;
      const toks = significantTitleTokens(n.title);
      if (toks.size < 2) continue;
      const matched = storyRefNodes.some(
        (r, i) =>
          withinSameEventWindow(n.publishedAt, r.publishedAt) &&
          looksRelatedToStory(toks, storyRefTokenSets[i]),
      );
      if (matched) {
        rescued.push(n);
        selectedKeys.add(n.key);
        socialRescued++;
        totalRescued++;
      }
    }
  }

  // (e) contrast rescue (Task #210): a CONTRAST item (CPC/SWL/EPC alignment or a
  // mixed/low/very-low factuality outlet — cls 'anchor-only', label 'contrast') is
  // pushed below the priority cutoff by its content-based score AND frames the same
  // event with DIVERGENT (propaganda / adversarial) wording, so it rarely token-
  // matches a mainstream headline strongly enough for the strict near-dup lane (b),
  // and lane (d) skips it (not social). Give contrast overflow nodes a dedicated,
  // bounded second chance to ride into the payload alongside the story they contrast.
  // Match each against the SAME storyRefNodes snapshot the social lane uses
  // (corroborating / primary-origin only — never another contrast or social node, so
  // contrast can only anchor to real reliable coverage), using the RELAXED
  // relatedness check (>= 2 shared significant tokens) plus the same-event time
  // window. overflowNodes is already priority desc, so this admits the strongest
  // contrast items first. Contrast is anchor-only — the formation gate counts only
  // corroborating, the representative pool is primaries then corroborating, and
  // synthesis routes contrast to spins only — so it can NEVER seed, represent, or
  // inform the facts of a story; the LLM grouping + coherence guard + >=2 formation
  // gate still decide the final attachment. This only widens RECALL. NOTE: a
  // social-cpc outlet derives to contrast AND flags isSocialFlash, so it is eligible
  // for both lanes (d) and (e) — the selectedKeys check prevents double-admission.
  let contrastRescued = 0;
  // Last heuristic lane — no floors left to reserve; guaranteed at least
  // CONTRAST_RESCUE_FLOOR (8) by the earlier lanes' arithmetic.
  const contrastCap = Math.min(
    CONTRAST_RESCUE_BUDGET,
    Math.max(0, TOTAL_RESCUE_CEILING - totalRescued),
  );
  if (storyRefNodes.length > 0) {
    for (const n of overflowNodes) {
      if (contrastRescued >= contrastCap) break;
      if (selectedKeys.has(n.key)) continue;
      if (!(n.cls === 'anchor-only' && n.label === 'contrast')) continue;
      const toks = significantTitleTokens(n.title);
      if (toks.size < 2) continue;
      const matched = storyRefNodes.some(
        (r, i) =>
          withinSameEventWindow(n.publishedAt, r.publishedAt) &&
          looksRelatedToStory(toks, storyRefTokenSets[i]),
      );
      if (matched) {
        rescued.push(n);
        selectedKeys.add(n.key);
        contrastRescued++;
        totalRescued++;
      }
    }
  }

  // The normal automatic lanes stay hard-bounded at HARD_NODE_CEILING. Editor
  // manual-link members are intentionally additive and are NEVER tail-sliced:
  // a final flat slice could otherwise cut a whole same-event rescue bucket in
  // half after an unusually large editor overlay. This preserves both the human
  // decision and the >=2 corroborating formation invariant; the editor overlay
  // itself remains bounded by its persisted effective URL cap.
  const allNodes = [...primaryNodes, ...rescued];
  return {
    allNodes,
    primaryCount: primaryNodes.length,
    rescuedActiveOrNearDup: continuityRescued + nearDupRescued,
    rescuedNearDup: nearDupRescued,
    rescuedArchiveGrace: archiveGraceRescued,
    rescuedEventBucket: eventBucketRescued,
    rescuedIdenticalTitle: identicalTitleRescued,
    rescuedSocial: socialRescued,
    rescuedContrast: contrastRescued,
    rescuedManualLink: manualLinkRescued,
    overflowCount: overflowNodes.length,
    primaryAdversary,
    primaryContributing,
    deferredAdversary,
  };
}

// --- Curated-lane AI resilience (rate-limit hardening) ---------------------
// The grouping + coherence-guard calls are the GATE for forming curated Top
// Stories. gpt-4o is the PRIMARY for these Tier-1 curated reasoning calls
// (clustering, coherence guard, semantic adversary attach, process re-partition,
// anchor-split). Grouping quality is provider-sensitive: gpt-4o groups a single
// developing event (e.g. an attack + the official statements reacting to it)
// into ONE story, whereas Claude over-fragments it into several near-duplicate
// clusters — so the same sub-story can appear split across two cards. Claude
// Sonnet is the automatic fallback (different upstream provider, rate-limited
// independently) and a fast Claude haiku is the last resort. When the primary is
// transiently rate-limited (429) the whole pass used to form ZERO new clusters
// until it recovered — so a busy news day could sit un-grouped for many cycles
// (identical stories shown as separate cards). TWO layers absorb that throttle:
// FIRST, createPreferOpenRouter() itself falls back from OpenRouter to the
// Anthropic integration on an OpenRouter failure (so a gpt-4o blip is usually
// served by Claude with the SAME body before this chain ever advances); SECOND,
// only if that shared call still THROWS (e.g. both providers failed) does this
// chain step to the next model entry — and only on a TRANSIENT failure (429 /
// 5xx / network / open breaker); a genuine error (bad prompt, malformed request)
// surfaces immediately. So the chain entries below are a SECONDARY safety net,
// not the primary fallback path. This is CURATED-LANE ONLY: it lives entirely in
// this file.
//
// createPreferOpenRouter also PINS the primary to OpenRouter (gpt-4o) regardless
// of the global "Internal AI" toggle. Grouping is the one place where provider
// choice visibly changes the output (Claude over-fragments a single developing
// event into several near-duplicate clusters), so it must not silently flip to
// Claude when an operator routes every OTHER feature to Internal AI.
const CURATED_CLUSTER_MODEL_CHAIN = [
  'gpt-4o', // primary (mapped to openai/gpt-4o): best neutral multi-doc grouping
  'anthropic/claude-sonnet-4.5', // fallback 1: comparable reasoning, different provider
  'anthropic/claude-haiku-4.5', // fallback 2: fast last resort
];

type CuratedClusterCreateBody = Parameters<typeof openai.chat.completions.create>[0];

// Test-only injection seam (Task #714). ESM named imports are read-only, so a
// regression test cannot reassign the imported `createPreferOpenRouter` to
// simulate an all-providers timeout. This nullable override lets the
// timeout-recovery test inject a stub WITHOUT a mocking framework; production
// always leaves it null and uses the real shared client unchanged, so it
// changes no production behavior.
let curatedClusterCompletionOverride: typeof createPreferOpenRouter | null = null;
export function __setCuratedClusterCompletionForTest(
  fn: typeof createPreferOpenRouter | null,
): void {
  curatedClusterCompletionOverride = fn;
}

// Race a promise against an AbortSignal so the clustering pass's hard timeout
// releases an in-flight AI call immediately with an AbortError instead of waiting
// for withAiTimeout's own backstop. The underlying request is intentionally
// abandoned; a no-op catch prevents an unhandled rejection if the abandoned
// promise later rejects. Curated-lane only.
function raceWithAbortClustering<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    const err = new Error('Curated clustering cancelled (signal already aborted)');
    err.name = 'AbortError';
    return Promise.reject(err);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      const err = new Error('Curated clustering cancelled (abort while in flight)');
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

export async function createCuratedClusterCompletion(
  body: CuratedClusterCreateBody,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof openai.chat.completions.create>>> {
  let lastErr: unknown;
  const completion = curatedClusterCompletionOverride ?? createPreferOpenRouter;
  for (let i = 0; i < CURATED_CLUSTER_MODEL_CHAIN.length; i++) {
    const model = CURATED_CLUSTER_MODEL_CHAIN[i];
    try {
      // THREE-LAYER hang protection:
      // 1. SDK-level per-request timeout aborts the HTTP request at the source
      //    (primary OpenRouter path only; Anthropic fallback ignores it).
      // 2. withAiTimeout race backstop catches the Anthropic fallback path too.
      // 3. raceWithAbortClustering: races the whole call against the pass's own
      //    AbortSignal (Task #987) so the 10-min hard timeout releases an in-flight
      //    provider call IMMEDIATELY instead of waiting for the SDK/backstop ceiling.
      // trackStorm: false — curated-lane failures must NEVER trip the main-feed
      // storm detector, and the main-feed storm must NEVER fast-skip curated calls.
      const result = await raceWithAbortClustering(
        withAiTimeout(
          completion(
            { ...body, model },
            { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 },
          ),
          AI_CALL_BACKSTOP_MS,
          `curatedClustering(${model})`,
          { trackStorm: false },
        ),
        signal,
      );
      if (i > 0) {
        console.warn(
          `[CuratedCluster] grouping/guard served by fallback model "${model}" (primary transiently failed)`,
        );
      }
      // Spend telemetry (Task #1100) — log-only aggregation, never alters the
      // response. `result.model` is the model that ACTUALLY served (the shared
      // client's Anthropic fallback stamps the real Claude model even when this
      // chain entry asked OpenRouter for gpt-4o).
      recordCuratedAiCallOk('clustering', result, model);
      return result;
    } catch (err) {
      lastErr = err;
      const isLast = i === CURATED_CLUSTER_MODEL_CHAIN.length - 1;
      // Only a TRANSIENT provider failure is worth trying another provider; a
      // genuine error won't be fixed by it, so re-throw it immediately.
      if (isLast || !isTransientAIError(err)) {
        recordCuratedAiCallFailure('clustering'); // telemetry only (Task #1100)
        throw err;
      }
      console.warn(
        `[CuratedCluster] model "${model}" transiently unavailable; trying "${CURATED_CLUSTER_MODEL_CHAIN[i + 1]}"`,
      );
    }
  }
  throw lastErr;
}

// Tolerant JSON-object parse. The primary model (gpt-4o) returns a BARE JSON
// object, while the Claude fallback wraps its JSON object in a ```json … ```
// markdown fence even in json_object mode — so this must handle both. Try a
// direct parse, then strip a single code fence, then slice the outermost {…}
// span. Returns null when nothing parseable is found (callers keep the previous
// clusters), preserving the existing fail-safe semantics.
function parseJsonObjectLoose(content: string): unknown {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return null;
    }
  };
  const direct = tryParse(content);
  if (direct !== null) return direct;
  const unfenced = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const fromUnfenced = tryParse(unfenced);
  if (fromUnfenced !== null) return fromUnfenced;
  const first = unfenced.indexOf('{');
  const last = unfenced.lastIndexOf('}');
  if (first !== -1 && last > first) return tryParse(unfenced.slice(first, last + 1));
  return null;
}

// Returns the grouping, or null when the LLM call itself failed (network error,
// empty/malformed response). Callers MUST distinguish null (failure — keep the
// previous clusters) from [] (the model ran and genuinely found no groups —
// safe to clear), so a single hiccup never wipes the visible Top Stories.
// Deterministic, network-free grouping for the curated-isolation harness only
// (Task #492). Groups nodes that share a normalized-title signature — enough to
// prove the clustering grouping path runs and groups obvious same-event items
// without any AI call. Never used by the live pass (no opts → real LLM path).
function harnessStubGroups(nodes: LaneNode[]): ClusterGroup[] {
  const bySig = new Map<string, string[]>();
  for (const n of nodes) {
    const sig = (n.normalizedTitle && n.normalizedTitle.trim()) || normalizeTitle(n.title);
    const arr = bySig.get(sig) ?? [];
    arr.push(n.key);
    bySig.set(sig, arr);
  }
  return Array.from(bySig.values())
    .map(keys => ({ keys: Array.from(new Set(keys)) }))
    .filter(g => g.keys.length >= 2);
}

export async function identifyCuratedClusters(
  nodes: LaneNode[],
  opts?: { harnessStub?: boolean; signal?: AbortSignal },
): Promise<ClusterGroup[] | null> {
  if (nodes.length < 2) return [];

  // Test-harness deterministic exercise (Task #492): the curated-isolation gate
  // calls this directly with a tiny fixture and harnessStub:true so the grouping
  // path runs instantly and deterministically even during a live 429 storm. The
  // live clusterCuratedLane pass NEVER passes this flag, so production grouping is
  // unaffected.
  if (opts?.harnessStub) return harnessStubGroups(nodes);

  // Items are referenced by their 1-based INDEX number, never by their internal
  // id. The model only has to echo back small integers, so it can't drop a member
  // by mis-transcribing a 36-char UUID (which the old key-based contract did —
  // a single typo'd key was silently filtered out, collapsing a real 2-item
  // cluster below the formation gate), and the response stays tiny enough that it
  // never truncates at max_tokens.
  // Tag each item with how long ago it was published so the model can apply the
  // time rules below (a large gap / different day => different incident). Falls
  // back to "time unknown" when a row has no usable timestamp.
  const nowMs = Date.now();
  const list = nodes
    .map((n, idx) => formatClusteringPromptLine(n, idx, nowMs))
    .join('\n');

  const prompt = `Analyze these news items and identify groups that cover THE SAME underlying news event.

${CURATED_EVENT_IDENTITY_GUIDANCE}

Each item's headline is followed by " -- " and a short snippet of its body text where available. The headline alone can omit the specific subject — a ship, operation, or person — that the body names; use the snippet to recognize when two divergently-worded headlines describe the SAME underlying event. The snippet is supporting context only — it never overrides the separation rules above (counter-strike direction, different target/location, scheduled-event ahead-of vs. during phases, or a large time gap still keep items in different groups even if their snippets mention the same place or people). Some items have no snippet (title only); judge those on the headline and timing as before.

Items:
${list}

Consider EVERY item in the list, across ALL topics and regions — not only the most prominent or most-covered story. A smaller event (e.g. one strike, one incident in a secondary conflict) that has just two or three reports STILL forms a cluster and must not be overlooked because a different topic dominates the list.

Return a JSON object with a single property "clusters" whose value is an array of clusters. Each cluster object has:
- indices: array of the leading NUMBERS (from the numbered list above) of the items covering this same event

Only include clusters with 2 or more items. Items that are unique should be omitted.
Never put an item in a cluster about a different topic — when unsure, leave it out.

Worked example. Given these numbered items:
1. "US strikes Iranian nuclear sites"
2. "Pentagon confirms strikes on Iran's facilities"
3. "Iran launches missiles and drones at US bases in Kuwait and Bahrain"
4. "US intercepts Iranian missiles over the Gulf"
5. "US and Iran trade strikes as conflict escalates"
6. "Washington and Tehran exchange fire in widening standoff"
7. "China steps up patrols near Taiwan"
The correct grouping is THREE clusters and one omission:
- the US strike ON Iran: items 1 and 2
- Iran's counter-attack on US bases + its interception: items 3 and 4
- the MUTUAL EXCHANGE itself (both directions at once): items 5 and 6
The single-direction strike ON Iran (1,2) and Iran's strike on US bases (3,4) are SEPARATE incidents and must NOT be in the same cluster. The two-way "exchange" items (5,6) describe BOTH directions at once, fit neither single-direction story, and form their OWN third cluster alongside the other two — they are NOT merged into 1-2 or 3-4. "China steps up patrols near Taiwan" (item 7) is a different topic and is omitted.

Worked example (DIPLOMACY — different meetings stay apart). Given these numbered items:
1. "Opinion: Xi and Kim signal deepened China-North Korea nuclear cooperation"
2. "Turkey, US, Egypt and Saudi officials hold Cairo talks on Iran, Libya and Gaza"
3. "Beijing and Pyongyang reaffirm strategic partnership at leaders' meeting"
The correct grouping is at most the China-North Korea meeting on its own (items 1 and 3 — SAME parties, SAME subject) and the Cairo talks (item 2) standing alone. Items 1/3 and item 2 must NOT be merged: they share NO parties (China/North Korea vs Turkey/US/Egypt/Saudi) AND a DIFFERENT agenda (NK nuclear posture vs Iran/Libya/Gaza). They are two different diplomatic meetings — do NOT put them in one cluster just because both are "diplomatic talks". (If items 1/3 do not clearly describe the SAME meeting, leave them ungrouped too.)

Worked example (DIPLOMACY — micro-phases of ONE negotiation track stay together). Given these numbered items:
1. "US and Iran set to resume talks in Doha" (4h ago)
2. "US envoys arrive in Doha amid uncertainty over Iran talks" (1h ago)
3. "US envoys to meet Qatari mediators in Doha but no talks with Iranian officials planned" (1h ago)
The correct grouping is ONE cluster: items 1, 2, and 3. All three cover the SAME open-ended US-Iran negotiation track at the SAME venue (Doha), with Qatar as mediator. Item 1 is anticipation ("set to resume"), item 2 is arrival ("envoys arrive"), and item 3 is a status nuance ("meeting mediators / no direct talks with Iran yet") — these are micro-phase angles of the SAME ongoing track, not separate events. They must NOT be split into separate cards just because item 1 is ~3 hours earlier or because item 3 adds a qualification. The parties (US + Iran) and the track (the Doha negotiation) are identical across all three.

Example response format:
{
  "clusters": [
    {"indices": [1, 2]},
    {"indices": [3, 4]},
    {"indices": [5, 6]}
  ]
}

Return ONLY the JSON object, no other text.`;

  try {
    const response = await createCuratedClusterCompletion({
      // Model is overridden per-attempt by createCuratedClusterCompletion's chain
      // (Claude Sonnet primary -> gpt-4o fallback -> haiku); this string is a
      // no-op placeholder. A full reasoning model (never -mini) is required: -mini
      // conflated distinct incidents (folding a retaliatory counter-strike, even
      // unrelated topics, into one cluster) instead of following the
      // "same single incident" gate.
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
       // Index-based output is compact, but a busy pass can still return many
       // small clusters. Keep bounded, generous headroom so valid JSON is not
       // cut mid-array; the candidate payload remains independently bounded.
       max_tokens: 6000,
      // Structured output: the model is constrained to emit a syntactically valid
      // JSON object, so we no longer regex-scrape an array out of free text and we
      // no longer hit intermittent truncated/malformed-JSON parse failures that
      // silently wasted a whole clustering pass.
      response_format: { type: 'json_object' },
    }, opts?.signal);
    const content = response.choices[0]?.message?.content?.trim();
    if (!content) {
      console.warn('[CuratedCluster] LLM returned empty content — keeping previous clusters');
      return null;
    }
    const parsed = parseJsonObjectLoose(content);
    if (parsed === null) {
      // Distinct from a genuine "no clusters" result: the model ran but produced
      // output we cannot parse even after tolerating a markdown code fence (which
      // the Claude fallback adds around its JSON). Log loudly so it is visible
      // without combing stack traces, then keep the previous clusters.
      console.error(
        `[CuratedCluster] MALFORMED AI response (could not parse JSON) — keeping previous clusters :: ${aiResponseSnippet(content)}`,
      );
      return null;
    }
    const rawClusters = (parsed as { clusters?: unknown })?.clusters;
    if (!Array.isArray(rawClusters)) {
      console.error(
        `[CuratedCluster] MALFORMED AI response (expected a "clusters" array) — keeping previous clusters. Got keys: ${
          parsed && typeof parsed === 'object' ? Object.keys(parsed as object).join(',') : typeof parsed
        } :: ${aiResponseSnippet(content)}`,
      );
      return null;
    }
    // Map the model's 1-based indices back to node keys. Out-of-range or duplicate
    // indices are dropped per cluster; clusters that still have >= 2 valid members
    // survive. (Back-compat: also accept a legacy `keys` array if the model ever
    // returns one.)
    const validKeys = new Set(nodes.map(n => n.key));
    return (rawClusters as Array<{ indices?: unknown; keys?: unknown }>)
      .filter(c => c && typeof c === 'object')
      .map(c => {
        const fromIndices = Array.isArray(c.indices)
          ? c.indices
              .map(i => {
                // Accept JS numbers and numeric strings ("3"); require a 1-based
                // integer in range. Anything else maps to undefined and is dropped.
                const n = typeof i === 'number' ? i : typeof i === 'string' ? Number(i) : NaN;
                return Number.isInteger(n) && n >= 1 && n <= nodes.length ? nodes[n - 1]?.key : undefined;
              })
              .filter((k): k is string => !!k)
          : [];
        const fromKeys = Array.isArray(c.keys)
          ? (c.keys as unknown[]).filter((k): k is string => typeof k === 'string' && validKeys.has(k))
          : [];
        return { keys: Array.from(new Set([...fromIndices, ...fromKeys])) };
      })
      .filter(c => c.keys.length >= 2);
  } catch (error) {
    // API/network/timeout failure (thrown by the create() call above), distinct
    // from the inline malformed-payload markers. Fail-safe: return null so the
    // caller keeps the previous clusters — no member is dropped.
    console.error('[CuratedCluster] API/network error identifying clusters (keeping previous clusters):', error);
    return null;
  }
}

// Busy-day output-size safety for the coherence guard (below). The guard's reply
// is a compact index map, but on a very busy pass (many clusters, or a few very
// large ones) that reply can still exceed a single call's output budget and
// truncate mid-array — the parse then fails and the WHOLE pass falls back to the
// un-pruned grouping, so off-topic items linger exactly on the heaviest days.
//   - COHERENCE_GUARD_MAX_TOKENS gives each call generous output room (matching
//     the grouping pass) so its removal map can't truncate.
//   - MAX_CLUSTERS_PER_GUARD_CALL caps how many clusters ride in one call, so a
//     pass with more clusters than that splits across multiple calls (results
//     merged) and the per-call reply stays small regardless of total volume.
const COHERENCE_GUARD_MAX_TOKENS = 4000;
const MAX_CLUSTERS_PER_GUARD_CALL = 40;

// Test-only override for the coherence-guard chunk size (Task #982). Production
// always leaves this null and uses MAX_CLUSTERS_PER_GUARD_CALL unchanged; the
// in-loop abort regression test injects a tiny chunk size so a handful of
// clusters split across multiple guard-LLM batches, letting the test trip the
// pass's abort signal AFTER the first batch and assert the loop stops starting
// new AI calls. Curated-lane only; never widens the production default.
let maxClustersPerGuardCallOverride: number | null = null;
export function __setMaxClustersPerGuardCallForTest(n: number | null): void {
  maxClustersPerGuardCallOverride = n;
}

// Result of applying a coherence-guard removal map to a set of cluster groups.
export type CoherenceRemovalApplication = {
  groups: ClusterGroup[];
  droppedKeys: Set<string>;
  prunedClusters: number;
};

// Pure, deterministic application of the coherence guard's per-cluster removal map
// (Task #179). Extracted from pruneIncoherentClusters so the decision-APPLICATION
// logic can be unit-tested WITHOUT calling the LLM. `removeByCheckableCluster` is
// keyed by index into `checkable = groups.filter(g => g.keys.length >= 2)` (the
// exact indexing pruneIncoherentClusters builds), with 0-based item indices to
// drop. Contract:
//  - groups with < 2 members pass through untouched (only multi-member groups can
//    contain an outlier);
//  - ALL-FLAGGED PAIR (exactly 2 members, both flagged): the guard's "different
//    events" verdict — dissolve the cluster (return { keys: [] }) so the downstream
//    >= 2-corroborating formation gate drops both to standalones. This is the
//    CORRECT outcome for a genuine unrelated pair; the intact fail-safe would keep
//    a bogus merged card alive indefinitely.
//  - ALL-FLAGGED 3+ members: a degenerate guard answer — keep INTACT (fail-safe)
//    so a hiccup never wipes a valid larger cluster;
//  - droppedKeys counts DISTINCT node keys actually removed (overlapping clusters
//    can echo the same key, so a per-cluster sum would double-count);
//  - the returned ordering is [...pruned(checkable), ...passthrough], identical to
//    the original.
export function applyCoherenceRemovals(
  groups: readonly ClusterGroup[],
  removeByCheckableCluster: ReadonlyMap<number, ReadonlySet<number>>,
): CoherenceRemovalApplication {
  const checkable = groups.filter(g => g.keys.length >= 2);
  const passthrough = groups.filter(g => g.keys.length < 2);
  const droppedKeys = new Set<string>();
  let prunedClusters = 0;
  const pruned: ClusterGroup[] = checkable.map((g, ci) => {
    const remove = removeByCheckableCluster.get(ci);
    if (!remove || remove.size === 0) return g;
    const keptKeys = g.keys.filter((_, ii) => !remove.has(ii));
    if (keptKeys.length === 0) {
      // ALL members flagged — behavior depends on cluster size:
      if (g.keys.length === 2) {
        // PAIR BLIND SPOT FIX: for a 2-member cluster the guard's "flag both"
        // answer is the correct "different events" verdict — dissolve the pair so
        // both items fall back to standalones (empty keys; the >= 2-corroborating
        // formation gate treats the cluster as not forming). The fail-safe that
        // kept pairs intact was a structural bug: it prevented dissolution of
        // clearly unrelated article pairs.
        g.keys.forEach(k => droppedKeys.add(k));
        prunedClusters++;
        return { keys: [] };
      }
      // 3+ members all-flagged: likely a degenerate model answer — keep INTACT
      // (fail-safe) so a hiccup never wipes a good larger cluster.
      return g;
    }
    g.keys.forEach((k, ii) => { if (remove.has(ii)) droppedKeys.add(k); });
    prunedClusters++;
    return { keys: keptKeys };
  });
  return { groups: [...pruned, ...passthrough], droppedKeys, prunedClusters };
}

// Coherence guard (Task #177). The grouping LLM occasionally folds an item about
// a DIFFERENT event into an otherwise-correct cluster. This second, focused pass
// re-examines each formed group, identifies the dominant event, and drops any
// member that clearly does not belong to it. It is deliberately CONSERVATIVE
// (different angles of the SAME incident are kept) and FAIL-SAFE: if the call
// errors, returns unparseable output, or degenerately flags every member of a
// cluster, the original grouping is returned unchanged so a hiccup never wipes a
// good cluster. The caller re-applies the >= 2-corroborating formation gate
// afterwards, so a cluster shrunk past the bar dissolves cleanly.
export async function pruneIncoherentClusters(
  groups: ClusterGroup[],
  nodeByKey: Map<string, LaneNode>,
  abortSignal?: AbortSignal,
): Promise<ClusterGroup[]> {
  // Only multi-member groups can contain an outlier; nothing to validate below 2.
  const checkable = groups.filter(g => g.keys.length >= 2);
  const passthrough = groups.filter(g => g.keys.length < 2);
  if (checkable.length === 0) return groups;

  // Split the clusters into chunks so each guard call's reply stays small (see
  // MAX_CLUSTERS_PER_GUARD_CALL). Each chunk numbers its clusters 1..N locally;
  // chunkOffset maps that local number back to a global checkable-relative index.
  const perCall = maxClustersPerGuardCallOverride ?? MAX_CLUSTERS_PER_GUARD_CALL;
  const chunks: ClusterGroup[][] = [];
  for (let i = 0; i < checkable.length; i += perCall) {
    chunks.push(checkable.slice(i, i + perCall));
  }

  // Global (checkable-relative) cluster index -> 0-based item indices to remove,
  // merged across every chunk call. Chunks run sequentially to stay gentle on
  // the AI rate limit. A chunk that errors, returns empty, or returns
  // unparseable output is simply left un-pruned (fail-safe), so one hiccup costs
  // at most that one chunk instead of wiping pruning for the whole pass.
  const removeByCluster = new Map<number, Set<number>>();
  for (let ch = 0; ch < chunks.length; ch++) {
    // Early-stop (Task #716): stop starting new guard-LLM batches once the pass's
    // hard timeout has fired. Fail-safe — any un-checked chunk is simply left
    // un-pruned (same as an errored chunk), never wiped.
    if (abortSignal?.aborted) break;
    const chunk = chunks[ch];
    const chunkOffset = ch * perCall;

  // Index-addressed prompt: clusters numbered 1..M, items within each 1..N. The
  // model echoes back only small integers (cluster + item numbers), so it can't
  // drop a member by mis-transcribing a UUID.
  const lines: string[] = [];
  chunk.forEach((g, ci) => {
    lines.push(`Cluster ${ci + 1}:`);
    g.keys.forEach((k, ii) => {
      const n = nodeByKey.get(k);
      lines.push(`  ${ii + 1}. "${n?.title ?? '(unknown)'}" (${n?.source ?? 'unknown'})`);
    });
  });

  const prompt = `Each cluster below is SUPPOSED to contain only news items about ONE single real-world event. Occasionally an item about a DIFFERENT event was mistakenly grouped in.

For EACH cluster:
1. Determine the dominant event — the single incident that MOST of the items describe (same actors, same target, same place, same day). A clear pair or larger set describing the SAME specific event establishes the EVENT ANCHOR even if one minority item shares its country or broad theme. Express that anchor as an EVOLVING EVENT ENVELOPE: its concrete action and subject plus explicit continuity such as interception, official reaction, aftermath, casualty/damage update, a named proceeding, continuous operation or allowed multi-round campaign, or the same negotiation track. Do NOT freeze the anchor to one headline verb. EXCEPTION: if the cluster is a DEVELOPING DIPLOMATIC / NEGOTIATION PROCESS (a deal, agreement, ceasefire or peace negotiation, summit, talks, signing, treaty, or memorandum between the SAME parties about the SAME proposed agreement), the "dominant event" is that ongoing PROCESS, not a single-day incident. GUARD AGAINST A GENERIC-DIPLOMACY FALSE MERGE — the process exemption holds ONLY when the members share BOTH the SAME parties AND the SAME single agreement/negotiation track. If the apparent dominant event is "diplomacy"/"diplomatic talks" as a GENERIC theme (the members are actually DIFFERENT meetings — different participants, or a different agenda/subject/deal — lumped together just because all involve officials meeting or negotiating), that is NOT a single shared event: pick the dominant meeting (the SAME-parties+SAME-agreement group that most members belong to) and FLAG every member that is a DIFFERENT diplomatic meeting (different participants OR a different agenda) for removal. "Both are high-level diplomatic talks" is NOT enough to keep two different meetings together. ADDITIONALLY — a political accusation (an election-interference claim, a sanctions allegation, an espionage charge) is NOT a diplomatic process: a cluster whose apparent dominant event is an AI-cooperation statement, trade deal, or other policy track must NOT retain a political-accusation item as an "angle" of that process — flag it for removal.
2. Test EACH member against that event envelope. Keep it when it shares the anchor or has explicit continuity to the same incident or process. List it for removal when its concrete ACTION AND SUBJECT are different and it has no such continuity.

Be CONSERVATIVE. Different ANGLES of the SAME incident all BELONG and must NOT be flagged:
- the attack/launch itself, the interception/defense of it, casualties/aftermath, and official reactions to that SAME incident.
For a DIPLOMATIC / NEGOTIATION PROCESS cluster, the following are all ANGLES of the SAME process and must NOT be flagged just for differing in day or sub-topic: status updates, statements from EITHER party, conditions/demands, a third party's objections or attempts to derail it, mediator updates, signing mechanics, and the deal's DIRECT consequences. Do NOT flag such an item merely because it was published on a different day from the others — a deal story legitimately spans multiple days. MICRO-PHASE ANGLES of ONE open-ended negotiation track — anticipation coverage ("set to resume talks", "envoys to meet mediators"), arrival or in-progress coverage ("envoys arrive amid uncertainty"), and status/nuance updates ("no direct talks planned, only meeting mediators") of the SAME parties at the SAME venue/track — are ALL angles of that ONE process and must NEVER be flagged for removal from a diplomatic-process cluster. Do NOT flag a member merely because it describes a different moment of the track (anticipation vs. arrival vs. a status update) or because it adds a qualification ("but no direct talks planned"); these are complementary sub-angles, not separate events. (A KINETIC strike/attack item folded into a deal cluster IS a different event and SHOULD still be flagged.) IMPORTANT — when the dominant event of a cluster is a diplomatic deal/agreement/negotiation, a member describing a kinetic STRIKE, KILLING, RAID, or MILITARY OPERATION is a DIFFERENT event and MUST be flagged for removal, EVEN IF that member is framed as jointly or bilaterally confirmed ("Country A and Country B say <person> killed in strike", "confirmed by both governments", a joint statement). Two governments agreeing a strike HAPPENED is reporting an attack, not part of a deal — do NOT treat such joint-confirmation framing as a deal angle; flag the strike item. ALSO — when the dominant event is a diplomatic deal/agreement/negotiation, flag these NON-KINETIC spillover members too, because they are downstream of (not part of) the deal: (1) a MACRO / MARKET REACTION — oil or energy prices, stock-index or equity moves, currency moves, or a central-bank interest-rate decision (even one attributed to "war inflation" or the conflict); (2) the BROADER MULTILATERAL SUMMIT itself (e.g. a G7 / G20 / NATO summit) where the deal is just ONE agenda item; (3) a SEPARATE BILATERAL MEETING between a DIFFERENT pair of leaders held at the same venue (e.g. a Modi–Trump sideline meeting). These are NOT deal angles and SHOULD be flagged. Stay CONSERVATIVE otherwise — the deal's OWN terms, statements ABOUT the deal, conditions/demands, mediator updates and signing mechanics are still angles and must NOT be flagged.
SCHEDULED EVENT PHASES — if the cluster's dominant event is a SCHEDULED GATHERING (a summit / conference / forum with a defined start, e.g. a G7 / G20 / NATO summit), it has TWO distinct phases and a member from the OTHER phase must be flagged for removal: (1) AHEAD-OF / ANTICIPATION coverage published BEFORE it begins (previews, the agenda or what is expected, who WILL attend, address, push, raise, or discuss something at it — "Trump to address allies at G7", "leaders set to discuss Ukraine ahead of summit"); versus (2) DURING / AT-THE-EVENT coverage of it as it happens (it begins or opens, leaders gather or convene, sessions, sideline meetings, statements made AT it, its conclusions — "G7 Summit Begins", "World Leaders Gather for G7 Summit"). When MOST members are during-event, flag any pre-event ANTICIPATION member; when MOST members are pre-event, flag any during-event member. Coverage from DURING the event spanning the event's own days is the SAME phase and must NOT be flagged. This phase split is ONLY for scheduled gatherings — it does NOT apply to an open-ended deal / ceasefire / treaty negotiation (which legitimately spans days as one story) or to kinetic strikes.
ALSO — LEGISLATIVE / APPROPRIATIONS / BUDGET PROCESS SPILLOVER: when the dominant event of a cluster is a KINETIC MILITARY OPERATION (strikes, attacks, interceptions, air operations, casualties), flag any member that is actually about the LEGISLATIVE, APPROPRIATIONS, OR BUDGET PROCESS for that conflict — e.g. a Congressional spending package, NDAA / defense authorization fight, supplemental funding request, budget resolution, or a floor vote about war funding. Such items name the same war but describe Washington's funding debate, not the military operations, and are a DIFFERENT event. Exception: a specific official statement that DIRECTLY REACTS to the kinetic strikes (a condemnation, a threat, a casualty announcement tied to those strikes) still belongs — only pure funding / appropriations / budget / authorization-vote stories are flagged for removal from a kinetic cluster.
DOWNSTREAM ECONOMIC / MARKET EFFECT ≠ THE TRIGGERING EVENT: when the dominant event of a cluster is a MILITARY or GEOPOLITICAL event (a strike, attack, command decision, blockade, escalation, or crisis), flag any member that is actually about the ECONOMIC, MARKET, PRICE, or SUPPLY consequences of it — oil/fuel/energy price moves, stock or currency moves, shipping/insurance cost changes, supply-chain or commodity impacts, consumer price hikes, or a central-bank/government economic response attributed to the conflict. Such an item is thematically RELATED to the event but describes a DIFFERENT event with different actors (markets, regulators, consumers) and a different subject (prices/supply, not the military action). Example: a cluster whose dominant event is a US command decision about strikes near the Strait of Hormuz must NOT retain a member about a country raising domestic fuel prices because of the conflict — flag the fuel-price member. Conversely, when the dominant event IS a specific economic event (one country's price announcement, one day's oil spike), members covering that SAME economic event belong and must NOT be flagged.
Only flag an item when it is CLEARLY about a different event: a different incident, a different target or location, a counter-strike in the OPPOSITE direction, a downstream economic/market effect of the dominant event, a different conflict, or a different topic entirely. If it could genuinely be another phase or angle inside the anchored event envelope and the continuity is ambiguous, do NOT flag it.
EXCEPTION — SHARED ACTOR ≠ SHARED EVENT: once a clear same-event pair or larger set establishes the event anchor, a minority item whose concrete ACTION AND SUBJECT are both different and which has no explicit continuity to that incident or process MUST be flagged for removal. This remains decisive when every item concerns the same country, government, leader, region, broad security/diplomatic theme, or geopolitical backdrop. Those shared attributes are NOT continuity evidence. Worked contrast: two reports on Country A's annual domestic leadership retreat establish that proceeding as the anchor; a report on Country A's maritime-surveillance operation near Country B's undersea cable has a different action and subject and MUST be removed. Conversely, an attack report, interception report, official reaction, and aftermath update tied to that SAME attack fit its evolving event envelope and MUST remain together.
Also flag an official statement or social post that is VAGUE or GENERIC — one that does NOT name or clearly refer to this dominant incident's specific actors, target, place, or operation (e.g. a routine slogan, greeting, holiday/anniversary message, or broad policy/values statement) — because it is not actually about this event. But a SPECIFIC official reaction that DOES name or clearly refer to this incident still BELONGS and must NOT be flagged.

${lines.join('\n')}

SPECIAL CASE — EXACTLY 2-ITEM CLUSTERS: For a cluster that contains only 2 items, apply a STRICT "same real-world incident" test, NOT a "related topic" test: the two items must describe the SAME single incident (same actors, same action, same target/place, same timeframe) or the same negotiation track/process. Being about the same conflict, region, or theme is NOT enough — a pair where one item is a military/geopolitical event and the other is its downstream economic/market/price consequence, or where the two items are merely thematically related but describe different incidents, is a DIFFERENT-events pair. If both items describe DIFFERENT events (not different angles of the SAME event), list BOTH item numbers for removal. Flagging both items in a 2-item cluster is the correct "different events" verdict — it dissolves the pair so each item becomes a standalone entry. Do NOT avoid flagging both items in a 2-item cluster out of caution; if they are genuinely unrelated or only thematically related, listing both is correct and expected.

Return ONLY a JSON object of this shape:
{"clusters":[{"cluster":1,"remove":[2]},{"cluster":2,"remove":[]}]}
where "cluster" is the cluster number and "remove" lists the item numbers to drop from that cluster (an empty array means every item belongs).`;

    try {
      const response = await createCuratedClusterCompletion({
        // gpt-4o (not -mini): the focused outlier check needs the full model's
        // reliability at telling a same-incident angle from a different incident.
        // Overridden per-attempt by the chain helper (Claude Sonnet primary ->
        // gpt-4o fallback -> haiku); this string is a no-op placeholder.
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        // Generous output budget so a chunk's index map can't truncate mid-array;
        // combined with the chunking above the reply stays valid JSON at peak
        // volume (a truncated reply was the busy-day fall-back-to-unpruned bug).
        max_tokens: COHERENCE_GUARD_MAX_TOKENS,
        response_format: { type: 'json_object' },
      }, abortSignal);
      const content = response.choices[0]?.message?.content?.trim();
      if (!content) {
        console.warn('[CuratedCluster] Coherence guard returned empty content — keeping this chunk as-is');
        continue;
      }
      const parsed = parseJsonObjectLoose(content);
      if (parsed === null) {
        // Malformed payload (unparseable even after fence-stripping), distinct from
        // an API/network failure (thrown by the create() call above and caught
        // below). Fail-safe: keep this chunk as-is — no member is dropped.
        console.error(
          `[CuratedCluster] Coherence guard MALFORMED AI response (could not parse JSON) — keeping this chunk as-is :: ${aiResponseSnippet(content)}`,
        );
        continue;
      }
      const rawClusters = (parsed as { clusters?: unknown })?.clusters;
      if (!Array.isArray(rawClusters)) {
        console.error(`[CuratedCluster] Coherence guard MALFORMED AI response (missing "clusters" array) — keeping this chunk as-is :: ${aiResponseSnippet(content)}`);
        continue;
      }
      // chunk-local cluster-number (1-based) -> global checkable-relative index
      // (via chunkOffset); value is the set of 0-based item indices to remove.
      for (const c of rawClusters as Array<{ cluster?: unknown; remove?: unknown }>) {
        if (!c || typeof c !== 'object') continue;
        const cn = typeof c.cluster === 'number' ? c.cluster : Number(c.cluster);
        if (!Number.isInteger(cn) || cn < 1 || cn > chunk.length) continue;
        const removeIdx = new Set<number>();
        if (Array.isArray(c.remove)) {
          for (const r of c.remove) {
            const ri = typeof r === 'number' ? r : Number(r);
            if (Number.isInteger(ri) && ri >= 1) removeIdx.add(ri - 1);
          }
        }
        if (removeIdx.size) removeByCluster.set(chunkOffset + (cn - 1), removeIdx);
      }
    } catch (error) {
      // API/network/timeout failure (thrown by the create() call above), distinct
      // from the inline malformed-payload markers. Fail-safe: keep this chunk
      // as-is — no member is dropped.
      console.error('[CuratedCluster] Coherence guard chunk API/network error (non-fatal) — keeping this chunk as-is:', error);
      continue;
    }
  }

  if (removeByCluster.size === 0) return groups; // nothing flagged

  // Apply the per-cluster removal map deterministically via the pure, exported
  // helper (Task #179) so the decision-APPLICATION logic is unit-testable without
  // the LLM. The helper re-derives checkable/passthrough exactly as above, keeps
  // an all-flagged cluster intact (fail-safe), counts DISTINCT dropped keys, and
  // returns [...pruned, ...passthrough] — identical behavior to the prior inline
  // code; the empty-map fast path above is preserved.
  const { groups: result, droppedKeys, prunedClusters } = applyCoherenceRemovals(
    groups,
    removeByCluster,
  );
  if (droppedKeys.size > 0) {
    console.log(`[CuratedCluster] Coherence guard dropped ${droppedKeys.size} incoherent member(s) across ${prunedClusters} cluster(s)`);
  }
  return result;
}

// -----------------------------------------------------------------------------
// POST-FORMATION SEMANTIC ADVERSARY-ANGLE ATTACH (curated-lane only).
//
// Surfaces SEVERAL adversary / state-media angles (RT / TASS / Sputnik / CGTN /
// Press TV, etc. — classified contrast / attach-only) on each formed story,
// matched BY MEANING rather than by literal keyword overlap. Diagnosis showed
// adversary content reliably attaches but only ~1 per story, because contrast is
// low-priority (lands in the over-cap overflow), the contrast rescue lane needs
// >= 2 shared significant TITLE tokens (divergent propaganda wording dodges it),
// and the coherence guard prunes divergent framing as a "different event". This
// pass runs AFTER the trusted stories form and adds the MISSING angles.
// -----------------------------------------------------------------------------
const SEMANTIC_ADVERSARY_MAX_STORIES = 12; // biggest stories offered to the matcher
const SEMANTIC_ADVERSARY_MAX_CANDIDATES = 60; // adversary headlines offered (priority-ordered)
const SEMANTIC_ADVERSARY_PER_STORY_CAP = 4; // max adversary angles attached per story

// Pure, deterministic post-filter for the semantic-attach AI answer, so the
// decision logic is unit-testable without the LLM. Takes the raw {adversary,
// story} pairs the model returned (1-based, mirroring the indexed prompt) and
// yields the 0-based attachments to apply, after enforcing: valid index ranges
// (story 0 = "no match" is skipped), at most ONE attach per adversary item, the
// same-event time window, no duplicate of a node the story already carries, and
// a per-story cap. `matches` order is honored, so callers should pre-sort it
// deterministically (e.g. by adversary index = priority) for a stable cap.
export function selectSemanticAdversaryAttachments(
  matches: Array<{ adversary: number; story: number }>,
  opts: {
    storyCount: number;
    candidateCount: number;
    perStoryCap: number;
    withinWindow: (candidateIdx: number, storyIdx: number) => boolean;
    alreadyMember: (candidateIdx: number, storyIdx: number) => boolean;
  },
): Array<{ candidateIdx: number; storyIdx: number }> {
  const out: Array<{ candidateIdx: number; storyIdx: number }> = [];
  const usedCandidate = new Set<number>();
  const perStoryCount = new Map<number, number>();
  for (const m of matches) {
    if (!m || typeof m !== 'object') continue;
    const candidateIdx = Number(m.adversary) - 1;
    const storyIdx = Number(m.story) - 1; // story 0 -> -1, rejected below
    if (!Number.isInteger(candidateIdx) || candidateIdx < 0 || candidateIdx >= opts.candidateCount) continue;
    if (!Number.isInteger(storyIdx) || storyIdx < 0 || storyIdx >= opts.storyCount) continue;
    if (usedCandidate.has(candidateIdx)) continue; // one attach per adversary item
    if ((perStoryCount.get(storyIdx) ?? 0) >= opts.perStoryCap) continue;
    if (opts.alreadyMember(candidateIdx, storyIdx)) continue;
    if (!opts.withinWindow(candidateIdx, storyIdx)) continue;
    out.push({ candidateIdx, storyIdx });
    usedCandidate.add(candidateIdx);
    perStoryCount.set(storyIdx, (perStoryCount.get(storyIdx) ?? 0) + 1);
  }
  return out;
}

// Run the post-formation semantic attach. Mutates each matched pending story's
// `groupNodes` IN PLACE (adding the adversary node) and claims its key in
// `assignedKeys`; Phase B then persists + synthesizes it as a contrast member.
//
// SAFETY / ISOLATION (all preserved):
//   - Runs AFTER Phase A formation + representative selection, so an attached
//     adversary node can NEVER form a story (it's attach / anchor-only-contrast,
//     never corroborating), be the representative, or inform the corroborated
//     facts — synthesizeStory routes attach + anchor-only/contrast to spins /
//     alignments only.
//   - Runs AFTER the coherence guard ON PURPOSE: the semantic matcher IS the
//     precision gate here, bounded by a deterministic same-event TIME window +
//     per-story cap, so an unrelated item still cannot attach.
//   - FAIL-CLOSED: an unconfigured client or any AI / parse error / empty output
//     attaches NOTHING (exactly today's behavior). It only ever ADDS contrast
//     breadth to an already-formed story; it never removes or alters a member.
//   - clusterId stays driven by p.tokens (captured at Phase A, trusted members
//     only), so story IDENTITY is stable; only synthesisContentHash changes,
//     which correctly triggers a one-time re-synthesis to pick up the new angles.
async function semanticAttachAdversaryAngles(
  pending: Array<{ groupNodes: LaneNode[]; representative: LaneNode }>,
  candidateNodes: LaneNode[],
  assignedKeys: Set<string>,
  excludeKeys: Set<string> = new Set(),
  signal?: AbortSignal,
): Promise<{ count: number; attachedKeys: Set<string> }> {
  const noop = { count: 0, attachedKeys: new Set<string>() };
  if (pending.length === 0) return noop;
  if (!isAIConfigured()) return noop;

  const pubMs = (d: Date | null): number => (d ? new Date(d).getTime() : 0);

  // Un-attached adversary candidates from the FULL pool: not blocked, not already
  // claimed by a formed story, adversary/attach, with a usable title. Ordered
  // deterministically (priority desc, recency, key) and bounded so the prompt and
  // the per-story cap stay stable pass-to-pass.
  const candidates = candidateNodes
    .filter(n => !n.blocked && !assignedKeys.has(n.key) && !excludeKeys.has(n.key) && isAdversaryAttachNode(n) && !!n.title?.trim())
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        pubMs(b.publishedAt) - pubMs(a.publishedAt) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )
    .slice(0, SEMANTIC_ADVERSARY_MAX_CANDIDATES);
  if (candidates.length === 0) return noop;

  // Stories offered to the matcher: biggest first (the "big stories" the user
  // wants more angles on), bounded. Keep a map back to the original pending index.
  const stories = pending
    .map((p, idx) => ({ p, idx }))
    .sort(
      (a, b) =>
        b.p.groupNodes.length - a.p.groupNodes.length ||
        ((a.p.representative.url ?? a.p.representative.key) < (b.p.representative.url ?? b.p.representative.key)
          ? -1
          : 1),
    )
    .slice(0, SEMANTIC_ADVERSARY_MAX_STORIES);
  if (stories.length === 0) return noop;

  const clip = (s: string | null | undefined, n = 160): string =>
    (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

  const storyLines = stories.map((s, si) => {
    const rep = s.p.representative;
    const extras = s.p.groupNodes
      .filter(n => n.cls === 'corroborating' && n.key !== rep.key && !!n.title?.trim())
      .slice(0, 2)
      .map(n => `"${clip(n.title)}"`);
    const ctx = extras.length ? ` — also: ${extras.join('; ')}` : '';
    return `${si + 1}. "${clip(rep.title)}"${ctx}`;
  });
  const advLines = candidates.map((n, ci) => `${ci + 1}. "${clip(n.title)}" (${clip(n.source, 40)})`);

  const prompt = `You match ADVERSARY / STATE-MEDIA headlines to the news story each one covers, BY MEANING.

STORIES (each is a confirmed multi-source news story):
${storyLines.join('\n')}

ADVERSARY HEADLINES (state-controlled / low-trust outlets — they often use very different, slanted wording for the same event):
${advLines.join('\n')}

For EACH adversary headline, decide whether it covers the SAME SPECIFIC real-world development as ONE of the stories above — the same actors, the same incident, the same decision/announcement, within the same timeframe — NOT merely the same broad subject or country. Two separate diplomatic meetings, two different strikes, or two unrelated statements about the same conflict are DIFFERENT events and must NOT be matched. Propaganda framing rewords the same event heavily, so match on meaning (not shared words), but do NOT stretch a match across distinct events that only share a topic.

Return ONLY a JSON object of this shape:
{"matches":[{"adversary":1,"story":3},{"adversary":2,"story":0}]}
where "adversary" is the adversary headline number and "story" is the story number it matches. Use "story":0 when the adversary headline matches NO story (this is the correct answer for most headlines). List every adversary headline at most once, and only assert a match when you are confident it is the SAME specific development.`;

  let matches: Array<{ adversary: number; story: number }> = [];
  try {
    const response = await createCuratedClusterCompletion({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
    }, signal);
    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return noop;
    const parsed = parseJsonObjectLoose(content) as { matches?: unknown } | null;
    const raw = parsed?.matches;
    if (!Array.isArray(raw)) return noop;
    matches = raw
      .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
      .map(m => ({ adversary: Number(m.adversary), story: Number(m.story) }))
      .filter(m => Number.isFinite(m.adversary) && Number.isFinite(m.story));
  } catch (error) {
    console.warn(
      '[CuratedCluster] Semantic adversary attach failed (non-fatal) — attaching nothing:',
      error instanceof Error ? error.message : error,
    );
    return noop;
  }

  // Deterministic cap: process highest-priority adversary first (candidates are
  // priority-ordered, so ascending adversary index = priority desc) so a stable
  // match SET yields a stable capped subset and doesn't flap re-synthesis.
  matches.sort((a, b) => a.adversary - b.adversary);

  // Per-story existing member URLs, to skip re-adding a node the story already
  // carries (e.g. an adversary item that made the primary cut).
  const storyMemberUrls = stories.map(s => {
    const set = new Set<string>();
    for (const n of s.p.groupNodes) {
      const u = normalizeMemberUrl(n.url);
      if (u) set.add(u);
    }
    return set;
  });

  const attachments = selectSemanticAdversaryAttachments(matches, {
    storyCount: stories.length,
    candidateCount: candidates.length,
    perStoryCap: SEMANTIC_ADVERSARY_PER_STORY_CAP,
    withinWindow: (ci, si) =>
      withinSameEventWindow(candidates[ci].publishedAt, stories[si].p.representative.publishedAt),
    alreadyMember: (ci, si) => {
      const u = normalizeMemberUrl(candidates[ci].url);
      return !!u && storyMemberUrls[si].has(u);
    },
  });

  let attached = 0;
  const storiesTouched = new Set<number>();
  const attachedKeys = new Set<string>();
  for (const a of attachments) {
    const node = candidates[a.candidateIdx];
    const target = stories[a.storyIdx];
    target.p.groupNodes.push(node);
    assignedKeys.add(node.key);
    attachedKeys.add(node.key);
    attached++;
    storiesTouched.add(target.idx);
  }
  if (attached > 0) {
    console.log(
      `[CuratedCluster] Semantic adversary attach: added ${attached} adversary angle(s) across ${storiesTouched.size} story(ies) from ${candidates.length} candidate(s)`,
    );
  }
  return { count: attached, attachedKeys };
}

// Lightweight running-state getter so the manual curated re-cluster endpoint can
// distinguish "ran" from "skipped because a pass is already in flight" WITHOUT
// adding a second lock — the single isClusteringRunning guard remains the only
// re-entrancy gate shared by the cron pass and a manual trigger. CURATED-ONLY.
export function isCuratedClusteringRunning(): boolean {
  return isClusteringRunning;
}

export async function clusterCuratedLane(
  opts: { mode?: 'full' | 'reshape'; forceSynthesis?: boolean; maxDurationMs?: number } = {},
): Promise<{ stories: number; members: number; skipped?: boolean }> {
  // 'full' (default) = unchanged behavior: the grouping LLM + every refinement
  // pass run. 'reshape' = the cheap DETERMINISTIC path: reuse the previous pass's
  // grouping and SKIP all four expensive LLM passes (grouping, coherence guard,
  // AI re-partition, semantic adversary attach) + synthesis + anchor-split, while
  // still re-running every deterministic stage (dedup, identical-title must-link,
  // overlay apply, formation gate, representative selection, decay/age-out,
  // Phase B, archive, metrics). Zero new AI cost; fail-closed (never wipes).
  // `forceSynthesis` (Task #660) opts a reshape back into the (bounded,
  // signature-cached) synthesis pass ONLY — used by the editor link/merge
  // commit path so a freshly merged/linked story's headline + key facts
  // regenerate in the SAME pass instead of waiting for the next full cron.
  const mode = opts.mode ?? 'full';
  const forceSynthesis = opts.forceSynthesis ?? false;
  if (isClusteringRunning) {
    // Stale-lock watchdog (Task #741). A prior pass normally releases the guard in
    // its `finally`, but if one ever truly wedges (a non-abortable hang that never
    // settles) the guard would stay held forever and freeze every future pass. If
    // the holder has run past CLUSTER_STALE_GUARD_MS we treat it as abandoned and
    // fall through to start a fresh pass. This is safe: an abandoned pass never
    // reached its wipe/rebuild, so existing clusters are preserved, and the run
    // token below neutralizes the stale pass's `finally` so it can't clear the new
    // pass's guard if it ever un-wedges.
    const heldForMs = clusteringStartedAt != null ? Date.now() - clusteringStartedAt : Infinity;
    if (heldForMs > CLUSTER_STALE_GUARD_MS) {
      console.warn(
        `[CuratedCluster] WATCHDOG: previous pass has held the lock for ${Math.round(heldForMs / 1000 / 60)} min (> ${Math.round(CLUSTER_STALE_GUARD_MS / 1000 / 60)} min stale ceiling) — treating it as abandoned and reclaiming the guard (existing clusters preserved)`,
      );
    } else {
      console.log('[CuratedCluster] Already running, skipping this pass');
      return { stories: 0, members: 0, skipped: true };
    }
  }
  isClusteringRunning = true;
  clusteringStartedAt = Date.now();
  const myRunToken = ++clusteringRunToken;
  // Hard-timeout early-stop (Task #716). Arm an AbortController that fires after
  // CLUSTER_MAX_DURATION_MS; the phase boundaries + per-cluster LLM loops below
  // check its signal and stop queueing NEW model work once it trips, so an
  // AI-storm pass can't keep hammering the shared client for many minutes after
  // it should have given up. Cleared in `finally`. trackStorm stays false on
  // every curated AI call, so this never touches the main-feed storm detector.
  const abortController = new AbortController();
  const abortSignal = abortController.signal;
  // Effective per-pass budget (same precedence as the abort timer below) and
  // the absolute wall-clock deadline derived from it. The synthesis pass uses
  // this to DEFER stories it cannot finish in time instead of launching LLM
  // calls the abort will kill mid-flight (Task #1088).
  const passBudgetMs =
    opts.maxDurationMs ?? clusterMaxDurationOverrideMs ?? CLUSTER_MAX_DURATION_MS;
  const passDeadlineAtMs = Date.now() + passBudgetMs;
  // Editor-priority yield hook: only a FULL pass is preemptible (a cheap
  // deterministic re-shape is already short and must not be interrupted).
  if (mode === 'full') currentFullPassAbort = abortController;
  const abortTimer = setTimeout(
    () => abortController.abort(),
    // A caller-supplied budget (the editor merge/link's bounded background
    // synthesis pass) takes precedence, then the test override, then the
    // production default. Curated-lane only; never widens the default.
    passBudgetMs,
  );
  try {
    console.log(
      mode === 'reshape'
        ? '[CuratedCluster] Starting DETERMINISTIC re-shape (no grouping LLM)...'
        : '[CuratedCluster] Starting two-tier curated clustering...',
    );

    const registry = await storage.getOutletRegistry();
    const outletIndex = buildOutletIndex(registry);
    const outletFor = (source: string, url: string) => findOutlet(outletIndex, source, url);
    // Behavior is derived live from the registry for BOTH the main feed and the
    // curated store, so a Source-Identifier / factuality / Blocked edit takes
    // effect on the next pass. Unknown outlets fail closed to attach.
    const behaviorFor = (source: string, url: string) => {
      const outlet = outletFor(source, url);
      const behavior = outlet
        ? deriveOutletBehavior(outlet)
        : deriveOutletBehavior({ factuality: null });
      return { outlet, behavior };
    };

    // Task #650 — a page-labeled ANALYSIS/OPINION piece (or a plain /opinion/
    // URL) from an otherwise-corroborating/anchor outlet is demoted to the same
    // attach-only tier as "other" sources: it may still ride along inside a
    // cluster, but it never counts toward formation, never anchors, and can
    // never become the representative (isEffectivelyReportedArticle handles the
    // rep-selection side separately). An outlet ALREADY flagged contrast
    // (adversary/CPC/low-factuality) is left untouched — this is about keeping
    // a trusted outlet's opinion column out of the primary/anchor tiers, not
    // about softening an adversary label.
    const demoteOpinionAnalysis = (
      behavior: ReturnType<typeof deriveOutletBehavior>,
      url: string,
      contentKind: string | null | undefined,
      title?: string | null,
    ): ReturnType<typeof deriveOutletBehavior> => {
      if (!shouldDemoteEffectiveOpinion(behavior.blocked, behavior.label, url, contentKind as any, title)) {
        return behavior;
      }
      const urlKind = deriveContentType(url);
      const signal = (contentKind === 'opinion' || contentKind === 'explainer')
        ? `page-label:${contentKind}`
        : (urlKind !== 'article' ? `url-token:${urlKind}` : `url-token:opinion`);
      console.debug(`[curated:demotion] url=${url} signal=${signal} stored=${contentKind ?? 'null'} → attach-only`);
      return { ...behavior, cls: 'attach', label: null, role: 'attach-only' };
    };

    // Gather the union of the main feed and the curated store.
    const mainFeed = await storage.getPrimaryFeed(CLUSTER_WINDOW_HOURS);
    const curatedStore = await storage.getCuratedStoreItems(CLUSTER_WINDOW_HOURS);
    // Per-item human content-kind override (Task #892). Load once for the whole
    // pass and apply to each node so the demoteOpinionAnalysis gate and all
    // downstream clustering tiers see the editor's intent immediately on deploy,
    // not waiting for a table-wipe+rebuild cycle. An 'explainer' override is
    // preserved as 'explainer' (distinct attach-only badge); every other
    // display value ('analysis'/'opinion'/'editorial'/'other') maps to
    // 'opinion' for demotion.
    let ckOverrides: Map<string, string>;
    try {
      ckOverrides = await storage.getCuratedContentKindOverrides();
    } catch {
      ckOverrides = new Map(); // fail-open: skip overrides on read error
    }

    const mainNodes: LaneNode[] = mainFeed.map(h => {
      const { outlet, behavior: rawBehavior } = behaviorFor(h.source, h.url);
      // Overrides key on the CANONICAL identity (normalizeIdentityUrl of the
      // stored url) — same key the storage boundary writes (review fix).
      const ckOvH = ckOverrides.has(normalizeIdentityUrl(h.url)) ? ckOverrides.get(normalizeIdentityUrl(h.url)) : undefined;
      const effectiveCk = ckOvH ? (ckOvH === 'explainer' ? 'explainer' : 'opinion') : ((h as any).contentKind ?? null);
      const behavior = demoteOpinionAnalysis(rawBehavior, h.url, effectiveCk, h.title);
      return {
        key: `main:${h.id}`,
        itemType: 'main' as const,
        itemId: h.id,
        title: h.title,
        normalizedTitle: h.normalizedTitle ?? null,
        source: h.source,
        url: h.url,
        category: h.category,
        cls: behavior.cls,
        label: behavior.label,
        role: behavior.role,
        blocked: behavior.blocked,
        priority: (h as any).priorityOverride ?? h.priorityScore ?? 0,
        ogImageUrl: h.ogImageUrl ?? null,
        contentKind: effectiveCk,
        publishedAt: h.articlePublishedAt ?? h.scrapedAt ?? null,
        sourceIdentifier: outlet?.sourceIdentifier ?? null,
        factuality: outlet?.factuality ?? null,
        ownership: (outlet?.ownership ?? []) as string[],
        summary: (h as any).summary ?? null,
        bullets: (h as any).summaryBullets ?? null,
        isSocialFlash: isSocialFlashOutlet(outlet),
      };
    });

    const curatedNodes: LaneNode[] = curatedStore.map(c => {
      const { outlet, behavior: rawBehavior } = behaviorFor(c.source, c.url);
      const ckOvC = ckOverrides.has(normalizeIdentityUrl(c.url)) ? ckOverrides.get(normalizeIdentityUrl(c.url)) : undefined;
      const effectiveCkC = ckOvC ? (ckOvC === 'explainer' ? 'explainer' : 'opinion') : ((c as any).contentKind ?? null);
      const behavior = demoteOpinionAnalysis(rawBehavior, c.url, effectiveCkC, c.title);
      return {
        key: `curated:${c.id}`,
        itemType: 'curated' as const,
        itemId: c.id,
        title: c.title,
        normalizedTitle: c.normalizedTitle ?? null,
        source: c.source,
        url: c.url,
        category: c.category,
        cls: behavior.cls,
        label: behavior.label,
        role: behavior.role,
        blocked: behavior.blocked,
        priority: c.priorityScore ?? 0,
        ogImageUrl: c.ogImageUrl ?? null,
        contentKind: effectiveCkC,
        publishedAt: c.articlePublishedAt ?? c.scrapedAt ?? null,
        sourceIdentifier: outlet?.sourceIdentifier ?? null,
        factuality: outlet?.factuality ?? null,
        ownership: (outlet?.ownership ?? []) as string[],
        summary: c.summary ?? null,
        bullets: c.summaryBullets ?? null,
        isSocialFlash: isSocialFlashOutlet(outlet),
      };
    });

    // Carry-over: keep the members of a still-alive cluster even after they age
    // out of the live window. Re-inject aged-out members as nodes (from their
    // snapshot) so they re-cluster through the normal pipeline — this keeps the
    // synthesis signature, member persistence, and the detail view all consistent.
    // Only DISPLAY-ELIGIBLE (non-blocked) live members count as "in window" — a
    // blocked member is an everywhere exclusion and must not keep a cluster alive.
    const inWindowKeys = new Set(
      [...mainNodes, ...curatedNodes].filter(n => !n.blocked).map(n => n.key),
    );
    const carriedNodes: LaneNode[] = [];
    // Keys of every member of a still-alive (non-phased-out) prior cluster —
    // INCLUDING the ones still in the live window (which are NOT re-injected as
    // carriedNodes). These are guaranteed payload slots so the priority cap can
    // never silently dissolve an existing story by dropping its members (Task #178).
    const activeClusterMemberKeys = new Set<string>();
    // Normalized URLs of those same active members (Task #207) — lets the priority
    // cap recognize an active member even after its key flips across passes.
    const activeClusterMemberUrls = new Set<string>();
    // Prior-pass cluster IDENTITIES, for stable-id reuse at formation (Task #301).
    // curated_cluster_members is wiped+rewritten each pass, so this holds EXACTLY
    // the previous pass's clusters. A churning mega-story re-mints a fresh
    // member-set hash every pass; matching the new grouping back to the prior
    // cluster lets us carry the SAME clusterId forward so it has ONE identity (one
    // synthesis row, one archive row) instead of leaving a phantom "phased out"
    // copy behind under the old hash.
    const priorIdentities: Array<{
      clusterId: string;
      tokens: Set<string>;
      headTokens: Set<string>;
      category: string | null;
      repUrl: string | null;
    }> = [];
    // Prior-pass grouping reused by the DETERMINISTIC re-shape path (mode ===
    // 'reshape'): the member keys of every still-alive (non-phased-out) cluster,
    // captured below as the carry-over loop walks them. Lets a re-shape re-run the
    // deterministic stages over the EXISTING grouping without paying for the
    // grouping LLM. Stays empty in 'full' mode (the grouping LLM rebuilds groups).
    const reshapePriorGroups: string[][] = [];
    // Surviving prior clusters' normalized member URLs + size, captured below in
    // the same carry-over walk — feeds the STORY-STICKY editor manual-link
    // expansion (expandManualLinkGroups) so an active link can hold a linked
    // story's CURRENT members together even after the exact snapshot URLs churn.
    // Phased-out clusters are deliberately excluded (they no longer exist to
    // expand into).
    const priorClusterUrlSets: PriorClusterUrls[] = [];
    // Per-URL title-token + published-time metadata for the story-sticky
    // adoption COHERENCE FILTER (see expandManualLinkGroups). Filled in the
    // same carry-over walk from the persisted prior members (which snapshot
    // title + publishedAt), then supplemented with current-pass live nodes at
    // the expansion call site so raw snapshot URLs still on screen always have
    // metadata even after their prior-member rows churned.
    const manualLinkUrlMeta = new Map<string, ManualLinkUrlMeta>();
    // Fresh-member release (episode split) — populated in the carry-over walk
    // below; declared here so the (a2) rescue union after the try/catch can see
    // it even if carry-over partially fails.
    const releasedFreshMemberUrls = new Set<string>();
    try {
      const prevMembers = await storage.getCuratedClusterMembers(CARRY_LOAD_WINDOW_HOURS);
      const prevByCluster = new Map<string, typeof prevMembers>();
      for (const m of prevMembers) {
        const arr = prevByCluster.get(m.clusterId) ?? [];
        arr.push(m);
        prevByCluster.set(m.clusterId, arr);
      }
      // Episode origination per prior signature (Task #334): the preserved archive
      // firstSeenAt for each prior clusterId, used below to bound how long ONE
      // identity may be reclaimed. A continuously-covered mega-story's live cluster
      // is a sliding recency window that never goes stale, so without this an
      // identity is reclaimed forever (the 5-day / 1,855-source zombie). A signature
      // absent from the map has no archive row yet (first/second formation) and is
      // treated as in-window so a brand-new story is never churned.
      const priorOriginations = await storage.getCuratedArchiveOriginationBySignatures(
        Array.from(prevByCluster.keys()),
      );
      const now = Date.now();
      const seenCarry = new Set<string>();
      // Fresh-member release (episode split). When a cluster is phased out at
      // carry-over, its STILL-FRESH contributing members previously vanished
      // with it — a fresh article that attached to an old episode was dragged
      // into the archive instead of re-forming as a new story. Collect those
      // members' normalized URLs here and feed them into the SAME (a2) rescue
      // sub-lane as archive-grace, so the priority cap re-admits the live
      // candidates and they can form a NEW cluster (fresh origination) this
      // pass. Contributing-only + freshness-gated (the cluster's own roll
      // window), so an old episode can never be resurrected through this lane.
      for (const [prevClusterId, mem] of Array.from(prevByCluster.entries())) {
        const repMem = mem.find(m => m.isRepresentative) ?? mem[0];
        // Staleness phase-out (Task #177). Derive the cluster's lifecycle from its
        // members' publishedAt timestamps and drop it once it goes stale, rather
        // than keeping it alive for as long as any member lingers in the window.
        // A mis-attached member CANNOT zombie a cluster across passes: the
        // coherence guard strips incoherent members BEFORE they are persisted, so
        // such a member is simply absent from prevMembers on the next pass and can
        // never, on its own, advance lastUpdate or hold a cluster open (step 2).
        const pubTimes = mem
          .map(m => (m.publishedAt ? new Date(m.publishedAt).getTime() : NaN))
          .filter(t => Number.isFinite(t)) as number[];
        // Capture the process/kinetic classification once — reused for BOTH the
        // staleness phase-out decision and the per-member rolling-window decay
        // below. A kinetic-dominant cluster (isDevelopingProcessCluster returns
        // false after the kinetic veto) uses the shorter decay window and the
        // kinetic phase-out ceiling, so it is never zombie'd by a war mentioning
        // ceasefire talks. Compute BEFORE the phase-out gate so the veto is
        // consistent in both places.
        const memberTitles = mem.map(m => m.title);
        const clusterIsProcess = isDevelopingProcessCluster(memberTitles);
        let keep: boolean;
        if (pubTimes.length === 0) {
          // No timestamps to reason about — fall back to the live-window signal so
          // a timestamp-less cluster is not dropped arbitrarily.
          keep = mem.some(m => inWindowKeys.has(`${m.itemType}:${m.itemId}`));
        } else {
          keep = !isClusterPhasedOut(pubTimes, now, {
            developingProcess: clusterIsProcess,
            lastContributingMs: lastContributingMs(mem),
          });
        }
        if (!keep) {
          // Phased-out cluster — let it drop, but RELEASE its still-fresh
          // contributing members so they can re-form as a NEW story instead of
          // being dragged into the archive with the old episode. Freshness =
          // the cluster's own current-state roll window (kinetic 24h / process
          // 48h, measured from NOW); contributing-only mirrors the archive-
          // grace anti-resurrection rule.
          const releaseWindowMs = (clusterIsProcess
            ? CARRY_MEMBER_PROCESS_ROLL_WINDOW_H
            : CARRY_MEMBER_ROLL_WINDOW_H) * 3_600_000;
          const releaseCutoffMs = now - releaseWindowMs;
          for (const m of mem) {
            if (((m as { cls?: string | null }).cls ?? (m as { behaviorClass?: string | null }).behaviorClass) !== 'corroborating') continue;
            if (!m.publishedAt) continue;
            const pubMs = new Date(m.publishedAt).getTime();
            if (!Number.isFinite(pubMs) || pubMs < releaseCutoffMs) continue;
            const mu = normalizeMemberUrl(m.url);
            if (mu) releasedFreshMemberUrls.add(mu);
          }
          continue;
        }
        // Per-member rolling-window decay. A kept cluster sheds its aged-out
        // members whose publishedAt is older than the current-state window,
        // measured from NOW:
        //   • Kinetic cluster: CARRY_MEMBER_ROLL_WINDOW_H (24h) — shed any
        //     member whose coverage pre-dates the current situation.
        //   • Developing-process cluster: CARRY_MEMBER_PROCESS_ROLL_WINDOW_H
        //     (48h) — keep earlier reporting while the deal/negotiation is active.
        // memberDecayCutoffMs is null when the cluster has no dated members at
        // all — in that case, no member decay is applied (all-or-nothing phase-out
        // already handles the cluster). Members without publishedAt are always
        // re-injected regardless of the cutoff (no basis to decay them).
        const memberRollWindowMs = (clusterIsProcess
          ? CARRY_MEMBER_PROCESS_ROLL_WINDOW_H
          : CARRY_MEMBER_ROLL_WINDOW_H) * 3_600_000;
        const memberDecayCutoffMs = pubTimes.length > 0 ? now - memberRollWindowMs : null;
        // Re-shape reuses this surviving cluster's grouping (its member keys) so a
        // deterministic re-shape can run without the grouping LLM (mode 'reshape').
        reshapePriorGroups.push(mem.map(m => `${m.itemType}:${m.itemId}`));
        // Story-sticky manual-link expansion source (surviving clusters only).
        {
          const clusterUrls = new Set<string>();
          for (const m of mem) {
            const cu = normalizeMemberUrl(m.url);
            if (!cu) continue;
            clusterUrls.add(cu);
            if (!manualLinkUrlMeta.has(cu)) {
              manualLinkUrlMeta.set(cu, {
                titleTokens: significantTitleTokens(m.title),
                publishedAt: m.publishedAt ?? null,
              });
            }
          }
          priorClusterUrlSets.push({ urls: clusterUrls, size: mem.length });
        }
        // Capture this surviving cluster's identity for stable-id reuse (Task #301
        // / #334). Gated AFTER the phase-out check so a phased-out story surrenders
        // its id (a re-formed story later starts a NEW episode), and gated on the
        // episode-age cap so a story may reclaim ONE identity only within its
        // bounded episode window — beyond that the continuing story mints a fresh
        // signature and the old archive episode closes (kills the zombie row). A
        // signature with no archive row yet (origination absent) stays eligible.
        const originationMs = priorOriginations.get(prevClusterId)?.getTime() ?? null;
        if (isPriorIdentityReclaimable({ keep, originationMs, nowMs: now })) {
          priorIdentities.push({
            clusterId: prevClusterId,
            tokens: new Set(mem.map(m => memberSignatureToken(m.url, `${m.itemType}:${m.itemId}`))),
            headTokens: significantTitleTokens(repMem?.title),
            category: repMem?.category ?? null,
            repUrl: repMem?.url ?? null,
          });
        }
        // This cluster survives — every one of its members is an "active" member
        // whose payload slot must be protected from the priority cap (Task #178).
        for (const m of mem) {
          activeClusterMemberKeys.add(`${m.itemType}:${m.itemId}`);
          const mu = normalizeMemberUrl(m.url);
          if (mu) activeClusterMemberUrls.add(mu);
        }
        for (const m of mem) {
          const key = `${m.itemType}:${m.itemId}`;
          if (inWindowKeys.has(key) || seenCarry.has(key)) continue; // still live / dup
          // Per-member rolling-window decay (current-state card). Shed this
          // carried member if its publishedAt pre-dates the cluster's current-
          // state window (kinetic: 24h, process: 48h, measured from NOW).
          // Members without publishedAt are always re-injected (no basis to
          // decay them). memberDecayCutoffMs is null when the cluster has no
          // dated members — skip the gate entirely in that case.
          if (memberDecayCutoffMs !== null && m.publishedAt) {
            const pubMs = new Date(m.publishedAt).getTime();
            if (Number.isFinite(pubMs) && pubMs < memberDecayCutoffMs) continue;
          }
          const { outlet, behavior: rawBehavior } = behaviorFor(m.source, m.url);
          if (rawBehavior.blocked) continue; // blocked is an everywhere exclusion
          // Carried members don't persist page-detected content_kind; pass the
          // stored title so title-based checks (trailing kicker, WH-lead dual
          // signal) still fire even when content_kind wasn't enriched yet.
          const behavior = demoteOpinionAnalysis(rawBehavior, m.url, null, m.title);
          seenCarry.add(key);
          carriedNodes.push({
            key,
            itemType: m.itemType as 'main' | 'curated',
            itemId: m.itemId,
            title: m.title,
            // Cluster-member rows don't store normalized_title; recompute it the
            // same way the ingest pipeline does so carried nodes still must-link.
            normalizedTitle: normalizeTitle(m.title),
            source: m.source,
            url: m.url,
            category: m.category,
            cls: behavior.cls,
            label: behavior.label,
            role: behavior.role,
            blocked: behavior.blocked,
            priority: m.priorityScore,
            ogImageUrl: m.ogImageUrl,
            publishedAt: m.publishedAt,
            sourceIdentifier: outlet?.sourceIdentifier ?? null,
            factuality: outlet?.factuality ?? null,
            ownership: (outlet?.ownership ?? []) as string[],
            summary: m.summary,
            bullets: null,
            isSocialFlash: isSocialFlashOutlet(outlet),
          });
        }
      }
    } catch (carryErr) {
      console.warn('[CuratedCluster] carry-over load failed (non-fatal):', carryErr instanceof Error ? carryErr.message : carryErr);
    }

    // Archive-grace rescue URLs (Part B). Independent + fail-soft: load recently
    // phased-out-but-still-fresh archive stories and collect the normalized URLs
    // of their CONTRIBUTING members (buildArchiveGraceMemberUrls) so the priority
    // cap can re-admit a live candidate that belongs to a story missed for a single
    // transient pass. Any error leaves the set empty (no rescue), never blocks a pass.
    let archiveGraceMemberUrls = new Set<string>();
    try {
      const graceRows = await storage.getCuratedArchiveGraceCandidates(
        ARCHIVE_GRACE_HOURS,
        ARCHIVE_GRACE_MAX_ROWS,
      );
      archiveGraceMemberUrls = buildArchiveGraceMemberUrls(graceRows, Date.now());
    } catch (graceErr) {
      console.warn('[CuratedCluster] archive-grace load failed (non-fatal):', graceErr instanceof Error ? graceErr.message : graceErr);
    }
    // Fresh-member release union (episode split). Still-fresh contributing
    // members of clusters phased out THIS pass share the (a2) rescue sub-lane
    // with archive-grace — same URL bound, same ARCHIVE_GRACE_ADMIT_MAX
    // admission cap inside RESCUE_BUDGET, so HARD_NODE_CEILING is unchanged.
    for (const u of releasedFreshMemberUrls) {
      if (archiveGraceMemberUrls.size >= ARCHIVE_GRACE_MAX_URLS) break;
      archiveGraceMemberUrls.add(u);
    }

    // Collapse the same ARTICLE to a single node. The curated store is a clone of
    // the main feed, so one article routinely exists as BOTH `main:<id>` and
    // `curated:<id>` (same URL). Counting both makes a single article count as two
    // sources — it then self-clusters into a fake "2 sources" story and inflates
    // sourceCount on real clusters. Collapse by normalized URL, preferring the
    // curated key (its curated_items row carries the enriched photo + bullets for
    // the detail view), else the higher-priority node. URL-less nodes can't be
    // deduped and are all kept. This matches what the read endpoints already
    // assume (clustering records ONE key per article).
    // Same shared identity normalizer used everywhere else (collapses tracking-
    // query variants of the same article — see server/urlIdentity.ts).
    const normUrl = normalizeMemberUrl;
    const dedupByUrl = new Map<string, LaneNode>();
    const urllessNodes: LaneNode[] = [];
    // Multi-story roundup digests (NPR "Up First", "X resigns. And, Y agrees to
    // a deal") are excluded from clustering ENTIRELY here — the single gate into
    // the candidate set — so they never seed, represent, become a member of, or
    // count toward any cluster. A 2-in-1 digest matches BOTH stories it stitches
    // together and, as a trusted contributing source, would otherwise be elected
    // representative and float between those clusters each pass, making a single
    // story card look like two merged topics. Their content is fully duplicated
    // by the dedicated single-topic articles in each story, so excluding them
    // loses no unique coverage. Read surfaces gate them separately (standalone
    // Top Stories + Top Narratives) so they don't surface as lone cards either.
    // Live-blog / live-umbrella pages are excluded here too (same single gate,
    // kill-switch CURATED_LIVE_NODE_EXCLUSION_DISABLED): their multi-sub-event
    // titles bridge DISTINCT events into one cluster when they ride in the LLM
    // payload, and their coverage is fully duplicated by single-topic articles.
    for (const n of [...mainNodes, ...curatedNodes, ...carriedNodes].filter(n =>
      !n.blocked &&
      !isRoundupDigestTitle(n.title) &&
      !(CURATED_LIVE_NODE_EXCLUSION_ENABLED && isLiveBridgeNode(n)),
    )) {
      const u = normUrl(n.url);
      if (!u) { urllessNodes.push(n); continue; }
      const existing = dedupByUrl.get(u);
      if (!existing) { dedupByUrl.set(u, n); continue; }
      const preferNew =
        (n.itemType === 'curated' && existing.itemType !== 'curated') ||
        (n.itemType === existing.itemType && n.priority > existing.priority);
      if (preferNew) dedupByUrl.set(u, n);
    }
    // Bound + recover the LLM payload (Task #178 + #199). Blocked outlets were
    // already dropped above (a hard everywhere exclusion). selectCandidateNodes is
    // a pure, unit-tested function: it keeps the top MAX_NODES by priority and adds
    // three BOUNDED rescue lanes — active-cluster members, near-duplicates of the
    // priority payload, and WHOLE same-event buckets discovered over the full
    // over-cap pool (the Task #199 fix for a mid-priority event living entirely
    // below the cutoff). The LLM + coherence guard still decide the final grouping;
    // the total never exceeds HARD_NODE_CEILING.
    const candidateNodes = [...Array.from(dedupByUrl.values()), ...urllessNodes];
    // EDITOR manual-link overlay (curated-only human must-link). Load the ACTIVE
    // links once per pass; their normalized member URLs both (a) rescue any linked
    // item into the payload below and (b) force those items into ONE group at the
    // reconcile step. Fail-OPEN: any error leaves the pass exactly as if there were
    // no manual links (never blocks clustering).
    let manualLinks: Awaited<ReturnType<typeof storage.getActiveCuratedManualLinks>> = [];
    try {
      manualLinks = await storage.getActiveCuratedManualLinks();
    } catch (e) {
      console.warn('[CuratedCluster] Could not load editor manual-links (continuing without):', e);
      manualLinks = [];
    }
    // EDITOR manual-EVICTION overlay (curated-only human cannot-link) — mirror of
    // the manual-link load above. Each active eviction pulls ONE wrongly-merged
    // member out of the cluster it landed in. Fail-OPEN: any error leaves the
    // pass exactly as if there were no evictions.
    let manualEvictions: Awaited<ReturnType<typeof storage.getActiveCuratedManualEvictions>> = [];
    try {
      manualEvictions = await storage.getActiveCuratedManualEvictions();
    } catch (e) {
      console.warn('[CuratedCluster] Could not load editor manual-evictions (continuing without):', e);
      manualEvictions = [];
    }
    // EDITOR manual-MOVE overlay (curated-only "belongs in that OTHER story") —
    // atomic evict-from-source + attach-to-target, applied AFTER evictions so a
    // move can never fuse the two clusters via the link reconcile. Fail-OPEN:
    // any error leaves the pass exactly as if there were no moves.
    let manualMoves: Awaited<ReturnType<typeof storage.getActiveCuratedManualMoves>> = [];
    try {
      manualMoves = await storage.getActiveCuratedManualMoves();
    } catch (e) {
      console.warn('[CuratedCluster] Could not load editor manual-moves (continuing without):', e);
      manualMoves = [];
    }
    const manualLinkMemberUrls = new Set<string>();
    for (const ml of manualLinks) {
      for (const u of ml.memberUrls ?? []) {
        const nu = normalizeMemberUrl(u);
        if (nu) manualLinkMemberUrls.add(nu);
      }
    }
    // Rescue the moved item + its target anchors into the payload too (same
    // rescue lane as manual-link members) so a below-cap item can still be
    // moved and its target still recognized. Source anchors are NOT rescued —
    // active-cluster members already ride their own rescue lane.
    for (const mvRow of manualMoves) {
      const iu = normalizeMemberUrl(mvRow.itemUrl);
      if (iu) manualLinkMemberUrls.add(iu);
      for (const u of mvRow.targetAnchorUrls ?? []) {
        const nu = normalizeMemberUrl(u);
        if (nu) manualLinkMemberUrls.add(nu);
      }
    }
    const selection = selectCandidateNodes(candidateNodes, activeClusterMemberKeys, activeClusterMemberUrls, archiveGraceMemberUrls, manualLinkMemberUrls);
    const allNodes = selection.allNodes;
    if (
      selection.rescuedActiveOrNearDup ||
      selection.rescuedArchiveGrace ||
      selection.rescuedEventBucket ||
      selection.rescuedIdenticalTitle ||
      selection.rescuedSocial ||
      selection.rescuedContrast ||
      selection.rescuedManualLink ||
      selection.deferredAdversary
    ) {
      console.log(
        `[CuratedCluster] Node selection: ${selection.primaryCount} by priority ` +
          `(${selection.primaryContributing} contributing/anchor, ${selection.primaryAdversary} adversary/attach; ` +
          `${selection.deferredAdversary} adversary deferred by cap) + ` +
          `${selection.rescuedActiveOrNearDup - selection.rescuedArchiveGrace - selection.rescuedNearDup} rescued (active-cluster) + ` +
          `${selection.rescuedNearDup} rescued (near-dup) + ` +
          `${selection.rescuedArchiveGrace} rescued (archive-grace) + ` +
          `${selection.rescuedIdenticalTitle} rescued (identical-title) + ` +
          `${selection.rescuedEventBucket} rescued (same-event buckets) + ` +
          `${selection.rescuedSocial} rescued (social-flash) + ` +
          `${selection.rescuedContrast} rescued (contrast) + ` +
          `${selection.rescuedManualLink} rescued (editor manual-link) ` +
          `from ${selection.overflowCount} over-cap candidates`,
      );
    }

    if (allNodes.length < 2) {
      console.log('[CuratedCluster] Not enough items to cluster');
      // A re-shape NEVER destructively wipes — with nothing to cluster it leaves
      // the existing clusters intact and the next full cron pass rebuilds them.
      if (mode !== 'reshape') await storage.replaceCuratedClusterMembers([]);
      return { stories: 0, members: 0 };
    }

    const nodeByKey = new Map(allNodes.map(n => [n.key, n]));

    // EDITOR manual-link must-link (curated-only), computed EARLY — before the
    // reshape early-bail below — so a reshape triggered by a fresh editor
    // link/merge on currently-standalone items (no prior cluster to re-shape)
    // is not silently no-op'd before the reconcile step below ever sees it
    // (Task #660). Maps each active link's normalized member URLs to the node
    // KEYS present this pass. manualLinkKeyGroups only keeps links with >= 2
    // present members (what can actually force a merge); manualLinkProtectedKeys
    // keeps EVERY resolved key (>= 1) so even a lone present member of an
    // active link stays protected below from the false-merge dissolution /
    // anchor-split backstops. Keyed by normalized URL (not node key) so it
    // survives the main:<id> <-> curated:<id> key flip across passes. Fail-open:
    // a link whose items have aged out to 0 present simply no-ops.
    const urlToKey = new Map<string, string>();
    for (const n of allNodes) {
      const nu = normalizeMemberUrl(n.url);
      if (nu && !urlToKey.has(nu)) urlToKey.set(nu, n.key);
    }
    const manualLinkKeyGroupsAll: string[][] = manualLinks.map(ml => Array.from(new Set(
      (ml.memberUrls ?? [])
        .map(u => urlToKey.get(normalizeMemberUrl(u)))
        .filter((k): k is string => !!k),
    )));
    const manualLinkKeyGroups = manualLinkKeyGroupsAll.filter(g => g.length >= 2);
    const manualLinkProtectedKeys = new Set<string>(manualLinkKeyGroupsAll.flat());

    // STORY-STICKY expansion (see expandManualLinkGroups): widen each link's
    // effective URL set with the CURRENT members of surviving prior clusters
    // the link still anchors, so the link keeps holding those stories together
    // as membership churns away from the exact snapshot URLs. The EXPANDED
    // groups feed ONLY the reconcile (merge) step below — the raw groups above
    // keep owning the reshape early-bail, applySplitOverlays, and the
    // manualLinkProtectedKeys dissolution/anchor-split exemptions, so a
    // machine-inferred per-pass set can never widen those safety backstops.
    const manualLinkRawUrlSets = manualLinks.map(ml => new Set(
      (ml.memberUrls ?? [])
        .map(u => normalizeMemberUrl(u))
        .filter((u): u is string => !!u),
    ));
    // Supplement the coherence-filter metadata with current-pass live nodes:
    // a raw snapshot URL still on screen keeps usable title/time metadata even
    // after its prior-member row churned out of the members table. Prior-member
    // snapshots (already in the map) win — they reflect what the editor saw.
    for (const n of allNodes) {
      const nu = normalizeMemberUrl(n.url);
      if (nu && !manualLinkUrlMeta.has(nu)) {
        manualLinkUrlMeta.set(nu, {
          titleTokens: significantTitleTokens(n.title),
          publishedAt: n.publishedAt ?? null,
        });
      }
    }
    const manualLinkExpansions = expandManualLinkGroups(manualLinkRawUrlSets, priorClusterUrlSets, manualLinkUrlMeta);
    const manualLinkKeyGroupsExpanded: string[][] = manualLinkExpansions.map(exp => Array.from(new Set(
      Array.from(exp.urls)
        .map(u => urlToKey.get(u))
        .filter((k): k is string => !!k),
    ))).filter(g => g.length >= 2);

    // Resolve each active EVICTION to present node keys (survives the main:/curated:
    // key flip via normalized identity URL). Only evictions whose evicted item is
    // present this pass are kept; the anchor guard inside applyManualEvictions then
    // decides whether it is still the wrongly-merged cluster before removing it.
    // STORY-STICKY (mirrors the manual-link expansion): each eviction's effective
    // anchor set is widened per pass with the current members of surviving prior
    // clusters its RAW snapshot still anchors, so the eviction keeps its grip on
    // an ACTIVE cluster as membership churns away from the snapshot URLs.
    const evictionRawInputs = manualEvictions.map(ev => ({
      evictedUrl: normalizeMemberUrl(ev.evictedUrl),
      anchorUrls: new Set(
        (ev.anchorUrls ?? [])
          .map(u => normalizeMemberUrl(u))
          .filter((u): u is string => !!u),
      ),
    }));
    const evictionExpansions = expandManualEvictionAnchors(evictionRawInputs, priorClusterUrlSets);
    const manualEvictionResolved: ManualEvictionResolved[] = manualEvictions
      .map((ev, i) => {
        const evictedKey = urlToKey.get(normalizeMemberUrl(ev.evictedUrl));
        const exp = evictionExpansions[i];
        const anchorKeys = new Set<string>(
          Array.from(exp.urls)
            .map(u => urlToKey.get(u))
            .filter((k): k is string => !!k),
        );
        if (exp.addedUrls > 0) {
          console.log(
            `[CuratedCluster] Editor manual-eviction story-sticky: eviction ${(ev.id ?? '').slice(0, 8)} ` +
            `expanded +${exp.addedUrls} anchor url(s) via ${exp.anchoredClusters} anchored cluster(s)`,
          );
        }
        return {
          evictedKey: evictedKey ?? '',
          anchorKeys,
          storedAnchorCount: (ev.anchorUrls ?? []).length,
          expanded: exp.addedUrls > 0,
        };
      })
      .filter(r => !!r.evictedKey);
    for (let i = 0; i < manualLinkExpansions.length; i++) {
      const exp = manualLinkExpansions[i];
      if (exp.addedUrls > 0) {
        console.log(
          `[CuratedCluster] Editor manual-link story-sticky: link ${(manualLinks[i]?.id ?? '').slice(0, 8)} ` +
          `expanded +${exp.addedUrls} url(s) via ${exp.anchoredClusters} anchored cluster(s)`,
        );
      }
    }

    // Resolve each active MOVE to present node keys. Both anchor sets ride the
    // SAME story-sticky expansion as evictions (evictedUrl = the moved item's
    // URL in both calls, so the item itself never counts as, nor is adopted
    // into, either anchor set): the SOURCE set keeps its grip on the cluster
    // being left, the TARGET set keeps its grip on the destination story as
    // membership churns away from the click-time snapshots.
    const moveSourceInputs = manualMoves.map(mv => ({
      evictedUrl: normalizeMemberUrl(mv.itemUrl),
      anchorUrls: new Set(
        (mv.sourceAnchorUrls ?? [])
          .map(u => normalizeMemberUrl(u))
          .filter((u): u is string => !!u),
      ),
    }));
    const moveTargetInputs = manualMoves.map(mv => ({
      evictedUrl: normalizeMemberUrl(mv.itemUrl),
      anchorUrls: new Set(
        (mv.targetAnchorUrls ?? [])
          .map(u => normalizeMemberUrl(u))
          .filter((u): u is string => !!u),
      ),
    }));
    const moveSourceExpansions = expandManualEvictionAnchors(moveSourceInputs, priorClusterUrlSets);
    const moveTargetExpansions = expandManualEvictionAnchors(moveTargetInputs, priorClusterUrlSets);
    const manualMovesResolved: ManualMoveResolved[] = manualMoves
      .map((mv, i) => {
        const itemKey = urlToKey.get(normalizeMemberUrl(mv.itemUrl));
        const srcExp = moveSourceExpansions[i];
        const tgtExp = moveTargetExpansions[i];
        const toKeys = (urls: Set<string>) => new Set<string>(
          Array.from(urls)
            .map(u => urlToKey.get(u))
            .filter((k): k is string => !!k),
        );
        if (srcExp.addedUrls > 0 || tgtExp.addedUrls > 0) {
          console.log(
            `[CuratedCluster] Editor manual-move story-sticky: move ${(mv.id ?? '').slice(0, 8)} ` +
            `expanded source +${srcExp.addedUrls} / target +${tgtExp.addedUrls} anchor url(s)`,
          );
        }
        return {
          itemKey: itemKey ?? '',
          sourceAnchorKeys: toKeys(srcExp.urls),
          sourceStoredCount: (mv.sourceAnchorUrls ?? []).length,
          sourceExpanded: srcExp.addedUrls > 0,
          targetAnchorKeys: toKeys(tgtExp.urls),
          targetStoredCount: (mv.targetAnchorUrls ?? []).length,
          targetExpanded: tgtExp.addedUrls > 0,
        };
      })
      .filter(r => !!r.itemKey);

    // GROUPING. 'full' calls the grouping LLM. 'reshape' reuses the previous
    // pass's grouping (the still-alive carry-over clusters, restricted to keys
    // still present this pass) so it pays for NO grouping LLM — the deterministic
    // stages below re-shape that existing grouping. With no prior grouping to
    // re-shape AND no active manual link that could stand up a brand-new group
    // below, a re-shape no-ops (it must never wipe) and bails before any write.
    let groups: ClusterGroup[] | null;
    if (mode === 'reshape') {
      groups = reshapePriorGroups
        .map(keys => ({ keys: keys.filter(k => nodeByKey.has(k)) }))
        .filter(g => g.keys.length >= 2);
      if (groups.length === 0 && manualLinkKeyGroups.length === 0) {
        console.warn('[CuratedCluster] re-shape has no prior grouping — preserving existing clusters');
        return { stories: 0, members: 0 };
      }
    } else {
      // PHASE BOUNDARY (Task #716): stop before the grouping LLM if the pass has
      // already blown its hard-timeout budget (preserves existing clusters).
      throwIfClusterAborted(abortSignal, 'before-grouping');
      groups = await identifyCuratedClusters(allNodes, { signal: abortSignal });
    }

    // The clustering LLM call failed (null, not an empty grouping). Preserve the
    // previously written clusters this pass instead of wiping them — Top Stories
    // stays visible and the next cron pass tries again. An empty [] still falls
    // through and clears, which is the correct behavior when news genuinely dies.
    if (groups === null) {
      console.warn('[CuratedCluster] Clustering call failed — preserving existing clusters for this pass');
      return { stories: 0, members: 0 };
    }

    // Coherence guard (Task #177): drop members the grouping folded in from a
    // DIFFERENT event BEFORE they ever reach persistence. Fail-safe — returns the
    // grouping unchanged on any error. The formation gate below then re-applies
    // the >= 2-corroborating rule, so a cluster shrunk past the bar dissolves.
    // Coherence guard (LLM) — skipped on re-shape: the reused grouping was already
    // coherence-pruned by the full pass that produced it.
    // PHASE BOUNDARY (Task #716): stop before the coherence-guard LLM batches if
    // the hard timeout has fired.
    if (mode !== 'reshape') throwIfClusterAborted(abortSignal, 'before-coherence-guard');
    const coherentGroups = mode === 'reshape'
      ? groups
      : await pruneIncoherentClusters(groups, nodeByKey, abortSignal);

    const members: Array<Omit<CuratedClusterMember, 'id' | 'createdAt'>> = [];
    // Formed stories captured for the synthesis pass (Task #90). One entry per
    // FORMED story carrying every member's synthesis context.
    const formedStories: Array<{ signature: string; synthMembers: SynthMember[] }> = [];
    let stories = 0;

    // Flight-recorder counters for the smart re-partition pass (Task #391). All
    // default to 0 so a pass that does no re-partitioning records honest zeros.
    let repartitionAudited = 0; // candidate groups handed to evaluateProcessRepartition
    let repartitionTriggered = 0; // groups the AI actually SPLIT this pass
    let repartitionCacheHits = 0; // skipped — membership unchanged since last eval
    let repartitionCooldownSkipped = 0; // skipped — within the 2h cooldown
    let repartitionChildrenCreated = 0; // total children across all splits this pass
    let repartitionMembersMoved = 0; // members landing under a child lineage (not parent)
    let repartitionFailed = 0; // AI call/parse failed → left intact (no member lost)
    // Early process-prevention subset (Task #414): the portion of the counters above
    // attributable to clusters that qualified via the LOWER early-prevention gate
    // (split before the 50-member backstop), so we can see prevention vs backstop.
    let preventionRepartitionAudited = 0;
    let preventionRepartitionTriggered = 0;
    let preventionRepartitionChildrenCreated = 0;

    // CROSS-GROUP DEDUP: the model can return overlapping groups that share an
    // item. Without this, the same item seeds two stories — duplicate rep ids
    // collide as React keys downstream and the view silently drops a cluster.
    // Process the largest groups first so the strongest cluster claims a shared
    // item, then exclude already-claimed items from every later group.
    const assignedKeys = new Set<string>();
    const nowMs = Date.now();
    // Content-completeness seeding gate (Task #231). A node is "fully enriched"
    // when it can stand as a story's FACE: a real headline, AI summary bullets,
    // and a REAL (non-favicon) image. Used to PREFER an enriched representative
    // so a formed story never renders a degraded face (favicon / no bullets).
    const isNodeFullyEnriched = (n: LaneNode): boolean =>
      !!(n.title && n.title.trim()) &&
      Array.isArray(n.bullets) && n.bullets.length > 0 &&
      !!n.ogImageUrl && !isFaviconUrl(n.ogImageUrl);
    // Deterministic identical-title must-link (curated syndication merge): force
    // any byte-identical-title pair from >= 2 distinct trusted publishers into ONE
    // group, even when the LLM split them across passes. reconcile merges/creates
    // groups; the UNCHANGED formation gate (>= 2 corroborating from >= 2 distinct
    // publishers), staleness and representative selection below still decide what
    // actually forms — this only collapses obvious same-article duplicates.
    const mustLinkGroups = buildIdenticalTitleMustLinkGroups(allNodes).map(g =>
      g.map(n => n.key),
    );
    // EDITOR manual-link must-link (curated-only) — force any link with >= 2
    // present members into ONE group. This runs AFTER the coherence prune
    // (coherentGroups), so a deliberate editor decision OVERRIDES the AI
    // grouping / coherence guard for exactly those items. manualLinkKeyGroups
    // was already computed above (before the reshape early-bail) and is reused
    // here unchanged.
    // Editor-feedback learned outlet-pair must-link enforcement RETIRED (Task
    // #1180). Legacy aggregate learned outlet-pair rules are no longer enforced
    // in the curated clustering hot path, so no learned outlet-pair groups are
    // ever produced. Kept as an always-empty group set so the reconcile call and
    // logging below stay unchanged. URL-specific human links above remain
    // deliberate editorial overlays and are unaffected.
    const learnedMustLinkGroups: string[][] = [];
    // Unified same-event consolidation (fundamental revision). ONE union-find
    // pass over formable groups + standalone corroborating nodes replaces the
    // former body-aware fuzzy standalone lane (Task #747), the cross-cluster
    // rep-vs-rep lane (Task #752), and the post-formation one-merge-per-pass
    // backstop (Task #1085) — see buildSameEventMergeComponents for the rules.
    // Fail-closed; full-mode only (reshape reuses the prior grouping and must
    // never discover new clusters). The missed-merge-reconcile admin flag is
    // the safety valve: OFF degrades to standalone-only merging (the old fuzzy
    // behavior) instead of going fully dark.
    //
    // Split overlays are fetched HERE (fail-open) so the same-overlay merge
    // guard sees them; the re-partition apply/eval stage below reuses this
    // list — the pass still fetches overlays exactly once.
    let activeSplitOverlays: CuratedProcessSplitOverlay[] = [];
    try {
      activeSplitOverlays = await storage.getActiveCuratedSplitOverlays();
    } catch (e) {
      console.warn('[CuratedCluster] Could not load split overlays (continuing without):', e);
      activeSplitOverlays = [];
    }
    let sameEventMergeGroups: string[][] = [];
    let sameEventGroupMerges = 0;
    if (mode !== 'reshape') {
      try {
        const consolidation = buildSameEventMergeComponents({
          groups: coherentGroups,
          nodes: allNodes,
          overlays: activeSplitOverlays,
          allowCrossGroupMerges: isCuratedMissedMergeReconcileEnabled(),
        });
        sameEventMergeGroups = consolidation.mustLinkGroups;
        sameEventGroupMerges = consolidation.crossGroupComponents + consolidation.foldComponents;
        if (sameEventMergeGroups.length > 0) {
          console.log(
            `[CuratedCluster] Same-event consolidation: ${consolidation.crossGroupComponents} group-merge, ` +
              `${consolidation.foldComponents} standalone-fold, ${consolidation.standaloneComponents} standalone-only component(s)`,
          );
        }
      } catch (e) {
        console.warn('[CuratedCluster] Same-event consolidation failed (non-fatal):', e);
        sameEventMergeGroups = [];
        sameEventGroupMerges = 0;
      }
    }

    // Exchange-framing cluster merge (Task #806). After the coherence guard,
    // detect pairs of LLM-formed clusters where BOTH reps are mutual-exchange
    // framed ("US and Iran exchange strikes") AND share the same two-actor pair
    // AND fall within the same-event window. This catches the case where the same
    // two-way exchange event is reported with divergent peripheral wording —
    // e.g. one card mentioning Hormuz/status, the other mentioning Gulf/oil — so
    // their body-aware token overlap (~0.43) never trips the generic cross-cluster
    // reconcile (which requires ≥0.6). Single-direction clusters ("US strikes
    // Iran") are never included because isMutualExchangeFraming rejects them.
    // Bounded budget; fail-closed; full-mode only; curated-lane only.
    const EXCHANGE_CLUSTER_MERGE_BUDGET = 6;
    let exchangeMustLinkGroups: string[][] = [];
    if (mode !== 'reshape') {
      try {
        type ExchangeGroupRep = { keys: string[]; rep: LaneNode; pairKey: string };
        const exchangeReps: ExchangeGroupRep[] = [];
        for (const g of coherentGroups) {
          const repNode = g.keys
            .map(k => nodeByKey.get(k))
            .filter((n): n is LaneNode => !!n && n.cls === 'corroborating' && !n.blocked)
            .sort((a, b) => b.priority - a.priority)[0];
          if (!repNode) continue;
          if (!isMutualExchangeFraming(repNode.title, repNode.summary)) continue;
          const pair = extractActorPair(repNode.title);
          if (!pair) continue;
          exchangeReps.push({ keys: g.keys, rep: repNode, pairKey: pair.join('|') });
        }
        outer2: for (let i = 0; i < exchangeReps.length; i++) {
          for (let j = i + 1; j < exchangeReps.length; j++) {
            if (exchangeMustLinkGroups.length >= EXCHANGE_CLUSTER_MERGE_BUDGET) break outer2;
            const eI = exchangeReps[i];
            const eJ = exchangeReps[j];
            if (eI.pairKey !== eJ.pairKey) continue;
            if (!withinSameEventWindow(eI.rep.publishedAt, eJ.rep.publishedAt)) continue;
            exchangeMustLinkGroups.push([...eI.keys, ...eJ.keys]);
          }
        }
        if (exchangeMustLinkGroups.length > 0) {
          console.log(
            `[CuratedCluster] Exchange-framing merge: ${exchangeMustLinkGroups.length} mutual-exchange cluster pair(s) merged`,
          );
        }
      } catch (e) {
        console.warn('[CuratedCluster] Exchange-framing merge failed (non-fatal):', e);
        exchangeMustLinkGroups = [];
      }
    }

    // Editor manual-links enter the reconcile via their story-sticky EXPANDED
    // key groups (raw snapshot ∪ anchored surviving clusters' current members)
    // so a link keeps merging the linked stories even after the snapshot URLs
    // churn out of them. Everything else here uses the same groups as before.
    const authoritativeReconciledGroups = reconcileMustLinkGroups(
      coherentGroups,
      [...mustLinkGroups, ...manualLinkKeyGroupsExpanded, ...sameEventMergeGroups, ...exchangeMustLinkGroups],
    );
    const reconciledGroupsPreEvict = reconcileLearnedAffinityGroups(
      authoritativeReconciledGroups,
      learnedMustLinkGroups,
    );
    // EDITOR manual-EVICTION overlay applied LAST (after every automatic merge)
    // so an explicit human "this doesn't belong" beats identical-title / learned /
    // fuzzy / cross-cluster merges that keep pulling the item back. Fail-closed:
    // only removes an item from a group still substantially the wrongly-merged
    // cluster (anchor guard), always re-seeds it as standalone (never lost).
    const evictionResult = applyManualEvictions(reconciledGroupsPreEvict, manualEvictionResolved, manualLinkKeyGroups);
    // EDITOR manual-MOVE overlay runs on the eviction output (still before the
    // split/formation stages consume the grouping): atomically re-homes each
    // moved item into its target story, or degrades to a plain eviction when
    // the target no longer survives churn. Moved keys are NOT in evictedKeys —
    // they may keep riding their new story downstream.
    const moveResult = applyManualMoves(evictionResult.groups, manualMovesResolved, manualLinkKeyGroups);
    const reconciledGroups = moveResult.groups;
    const evictedKeys = new Set<string>([...Array.from(evictionResult.evictedKeys), ...Array.from(moveResult.evictedKeys)]);
    if (evictionResult.applied > 0) {
      console.log(
        `[CuratedCluster] Editor manual-eviction: pulled ${evictionResult.applied} wrongly-merged member(s) out to standalone (of ${manualEvictions.length} active)`,
      );
    }
    if (moveResult.applied > 0) {
      console.log(
        `[CuratedCluster] Editor manual-move: re-homed ${moveResult.movedKeys.size} member(s), ` +
        `degraded ${moveResult.evictedKeys.size} to standalone (of ${manualMoves.length} active)`,
      );
    }
    if (mustLinkGroups.length > 0) {
      console.log(
        `[CuratedCluster] Identical-title must-link: ${mustLinkGroups.length} group(s) reconciled`,
      );
    }
    if (manualLinkKeyGroups.length > 0) {
      console.log(
        `[CuratedCluster] Editor manual-link: ${manualLinkKeyGroups.length} group(s) applied (of ${manualLinks.length} active)`,
      );
    }
    if (learnedMustLinkGroups.length > 0) {
      console.log(
        `[CuratedCluster] Learned must-link (Task #659): ${learnedMustLinkGroups.length} outlet-pair group(s) applied`,
      );
    }

    // -------------------------------------------------------------------------
    // SMART PROCESS RE-PARTITION (Task #391) — curated-lane only. A developing-
    // process MEGA-cluster (a long-running negotiation/ceasefire that keeps
    // accreting distinct sub-threads) is SPLIT into its distinct CURRENT sub-
    // stories by a gated AI pass whose verdict is PERSISTED as a member-token
    // overlay — STABLE across passes (which rebuild the cluster table). We APPLY
    // active overlays HERE, before Phase A, so every downstream step (formation
    // gate, phase-out, rep selection, id, synthesis, archive) runs per child for
    // free — exactly like the identical-title must-link, but a SPLIT not a merge.
    // Fail-closed end to end: load/eval/apply are each wrapped so any failure
    // leaves the groups EXACTLY as reconciled (no member ever lost). Bounded:
    // <= MAX_REPARTITION_AI_EVALS_PER_PASS AI calls per pass.
    // -------------------------------------------------------------------------
    let splitGroups: SplitAppliedGroup[] = reconciledGroups.map(g => ({ keys: [...g.keys] }));
    try {
      // Reuse the overlays fetched above for the same-event merge guard — the
      // pass still loads overlays exactly once, before any lane mutates them.
      const overlays = activeSplitOverlays;
      // Re-shape never runs the AI re-partition; it only re-APPLIES persisted
      // split overlays (deterministic) — same as the AI-unavailable branch below.
      if (mode !== 'reshape' && isAIConfigured()) {
        // Candidates: developing-process groups big enough to be worth an eval,
        // largest first (most likely to have fanned out). The authoritative size/
        // age gate is re-checked inside evaluateProcessRepartition; this only
        // prunes the loop so we never even look at small ordinary clusters.
        // With prevention ON, look at smaller process clusters too (the early gate
        // can qualify them); with it OFF, keep the legacy backstop-only floor.
        const minCandidateSize = CURATED_PROCESS_PREVENTION_ENABLED
          ? REPARTITION_PROCESS_MIN_CANDIDATE_SIZE
          : REPARTITION_MIN_CANDIDATE_SIZE;
        const candidates = reconciledGroups
          .map(g => {
            const nodes = g.keys
              .map(k => nodeByKey.get(k))
              .filter((n): n is LaneNode => !!n);
            return {
              group: g,
              nodes,
              // Per-cluster process detection — REQUIRED now that non-process
              // span candidates enter this loop: the developingProcess flag fed
              // to the gate/eval must reflect THIS cluster, or a non-process
              // cluster would wrongly qualify via the lower process-only floors.
              isProcess: isDevelopingProcessCluster(nodes.map(n => n.title)),
              spanH: clusterSpanHours(nodes),
            };
          })
          // INTENTIONAL (Task #440), evidence-backed: a cluster is a re-partition
          // candidate ONLY when it is a DEVELOPING-PROCESS cluster (a long-running
          // negotiation / ceasefire / deal that keeps accreting distinct CURRENT
          // sub-threads). A large NON-process cluster — e.g. a single big breaking
          // event covered by 40+ outlets — is deliberately LEFT INTACT: splitting
          // it would fragment one story into near-duplicate cards, the opposite of
          // the consolidation we want.
          //   PROD EVIDENCE (06-23 -> 06-24): the largest live non-process cluster
          //   was 21 members / 15 publishers, ALL the SAME single event ("IAEA
          //   inspectors will visit Iran's nuclear sites": ABC, NPR, BBC, AP, DW,
          //   TASS, …). Collapsing those 21 outlets into ONE card is exactly the
          //   product goal (a dense common-operating-picture, not 21 dupes), so
          //   that consolidation is the bound, not a bug. The historical 40-66
          //   member cards were likewise single mega-events (initial Iran strike /
          //   ceasefire coverage). For a non-process cluster the bound against a
          //   genuine FALSE-merge (two events lumped together) is delivered the
          //   OTHER way: anchorAwareSplitFormedStories releases off-anchor members
          //   (anchor_split_released ~121 over the 36h window) and the false-merge
          //   dissolution path — neither of which fragments a real single story.
          // So mega-cluster prevention is scoped to PROCESS stories by design;
          // non-process single-event clusters never reach the model regardless of
          // size. (The backstop in passesRepartitionGate still applies to TRULY
          // runaway clusters via the developingProcess flag.)
          //   AMENDMENT (long-SPAN branch): the process-only scope above holds
          //   for TIME-COMPACT clusters — but production (07-19) showed a
          //   72-member KINETIC cluster whose members SPANNED 25+ hours of
          //   published dates ballooning un-examined because kinetic vocabulary
          //   never trips isDevelopingProcessCluster. A cluster whose member
          //   span >= SPLIT_SPAN_H (2x the same-event window) while >=
          //   SPLIT_SPAN_SIZE_FLOOR members is no longer plausibly ONE
          //   time-compact event, so it now ALSO becomes a candidate (reason
          //   'span', prevention budget). This widens only WHO GETS LOOKED AT:
          //   the AI leave_intact verdict + the >=2-corroborating-publishers-
          //   per-child cap still guard against fragmenting a genuine single
          //   big event, so the IAEA-style consolidation above stays intact.
          .filter(
            c =>
              (c.isProcess && c.nodes.length >= minCandidateSize) ||
              (c.nodes.length >= SPLIT_SPAN_SIZE_FLOOR && c.spanH >= SPLIT_SPAN_H),
          )
          .sort((a, b) => b.nodes.length - a.nodes.length);

        // Inject the AI completion + overlay persist as deps so curatedRepartition
        // stays free of aiClient/storage imports (and unit-testable). complete
        // returns the model's raw text (createCuratedClusterCompletion adds the
        // Claude fallback); evaluateProcessRepartition wraps it fail-closed.
        const complete = async (prompt: string): Promise<string | null> => {
          const response = await createCuratedClusterCompletion({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: 1500,
            response_format: { type: 'json_object' },
          }, abortSignal);
          return response.choices?.[0]?.message?.content?.trim() ?? null;
        };
        const persist = (row: RepartitionOverlayWrite) => storage.upsertCuratedSplitOverlay(row);

        // Overlays as the eval mutates them — keyed by id so a re-evaluated overlay
        // replaces its loaded copy and a brand-new one is added, and the apply step
        // below sees the FRESH set.
        const overlayById = new Map(overlays.map(o => [o.id, o]));
        // Two SEPARATE per-pass AI budgets: the legacy backstop budget for clusters
        // that crossed the >=50 / old-and-large floors, and a small DEDICATED budget
        // for early-prevention evals (Task #414). Candidates are largest-first so the
        // backstop is always served before prevention, and the two budgets are
        // independent so prevention can never starve the backstop (or vice versa).
        const repartitionBudget = {
          backstop: MAX_REPARTITION_AI_EVALS_PER_PASS,
          prevention: CURATED_PROCESS_PREVENTION_ENABLED ? MAX_PREVENTION_AI_EVALS_PER_PASS : 0,
        };
        const repartitionUsed = { backstop: 0, prevention: 0 };
        for (const c of candidates) {
          // Early-stop (Task #716): this per-cluster loop makes one re-partition
          // LLM call per candidate, so check the hard-timeout signal before each
          // one and stop queueing new model work once it fires. `break` (not
          // throw) because this loop sits inside the fail-safe try/catch below —
          // a throw here would be swallowed; the boundary checks after this pass
          // (before semantic attach / synthesis / anchor-split) propagate the
          // abort. Already-evaluated overlays still apply deterministically.
          if (abortSignal.aborted) break;
          // Stop once BOTH budgets are spent.
          if (repartitionBudgetExhausted(repartitionBudget, repartitionUsed)) break;
          // Decide which budget bucket this candidate would draw from BEFORE we
          // spend a model call — using the EXACT size/age basis the eval re-checks
          // internally — and SKIP (not break) when that specific bucket is already
          // full. Skipping rather than breaking lets a later candidate still draw
          // from the OTHER (not-yet-full) bucket, so neither bucket can ever exceed
          // its cap and neither can starve the other.
          const ageH = clusterAgeHours(c.nodes, nowMs);
          const gate = passesRepartitionGate(c.nodes.length, ageH, {
            developingProcess: CURATED_PROCESS_PREVENTION_ENABLED && c.isProcess,
            spanH: c.spanH,
          });
          if (!shouldEvaluateRepartitionCandidate(gate, repartitionBudget, repartitionUsed)) {
            continue;
          }
          const existingOverlay = findOverlayForEval(c.nodes, Array.from(overlayById.values()));
          let res: Awaited<ReturnType<typeof evaluateProcessRepartition>> | null = null;
          try {
            res = await evaluateProcessRepartition(
              {
                nodes: c.nodes,
                existingOverlay,
                nowMs,
                developingProcess: CURATED_PROCESS_PREVENTION_ENABLED && c.isProcess,
              },
              { complete, persist },
            );
          } catch (evalErr) {
            console.warn(
              '[CuratedCluster] Re-partition eval errored (non-fatal):',
              evalErr instanceof Error ? evalErr.message : evalErr,
            );
            continue;
          }
          // Only outcomes that actually reached the model consume an AI budget;
          // cheap gate/cooldown/unchanged short-circuits do not. The gate tells us
          // (via res.prevention) which budget bucket the spent call belongs to —
          // and the pre-call skip above guarantees this never exceeds the cap.
          if (res.outcome === 'split' || res.outcome === 'intact' || res.outcome === 'ai_failed') {
            if (res.prevention) repartitionUsed.prevention++;
            else repartitionUsed.backstop++;
          }
          if (res.overlay) overlayById.set(res.overlay.id, res.overlay);
          repartitionAudited++;
          if (res.prevention) preventionRepartitionAudited++;
          if (res.outcome === 'split') {
            repartitionTriggered++;
            repartitionChildrenCreated += res.childrenCreated;
            if (res.prevention) {
              preventionRepartitionTriggered++;
              preventionRepartitionChildrenCreated += res.childrenCreated;
            }
          } else if (res.outcome === 'cooldown') {
            repartitionCooldownSkipped++;
          } else if (res.outcome === 'unchanged') {
            repartitionCacheHits++;
          } else if (res.outcome === 'ai_failed') {
            repartitionFailed++;
          }
        }
        // Apply the FRESH overlay set (loaded + just-evaluated active overlays).
        // Pass manualLinkKeyGroups so the apply step cannot scatter a linked set
        // across different children (editor override beats machine re-partition).
        splitGroups = applySplitOverlays(reconciledGroups, nodeByKey, Array.from(overlayById.values()), manualLinkKeyGroups);
      } else {
        // AI unavailable: still APPLY any persisted active overlays so existing
        // splits keep holding (deterministic, needs no AI).
        splitGroups = applySplitOverlays(reconciledGroups, nodeByKey, overlays, manualLinkKeyGroups);
      }
    } catch (repErr) {
      console.warn(
        '[CuratedCluster] Smart re-partition pass failed (non-fatal); groups left intact:',
        repErr instanceof Error ? repErr.message : repErr,
      );
      splitGroups = reconciledGroups.map(g => ({ keys: [...g.keys] }));
    }
    // membersMoved = members that landed under a CHILD lineage (re-partitioned),
    // not the residual parent — pure observability.
    repartitionMembersMoved = splitGroups.reduce(
      (sum, g) => sum + (g.splitLineageKey ? g.keys.length : 0),
      0,
    );
    if (repartitionTriggered > 0) {
      console.log(
        `[CuratedCluster] Smart re-partition: split ${repartitionTriggered} mega-cluster(s) into ` +
          `${repartitionChildrenCreated} child stories (${repartitionMembersMoved} members moved)`,
      );
    }

    const orderedGroups = [...splitGroups].sort((a, b) => b.keys.length - a.keys.length);

    // -------------------------------------------------------------------------
    // EDITOR MANUAL-MERGE CARVE-OUT (curated-only). An explicit editor MERGE is a
    // deliberate human decision that a specific set of items IS one story. Unlike
    // a soft "link" (which just feeds the normal grouping and still answers to the
    // formation gate), a MERGE is authoritative: its members are pulled OUT of
    // whatever cluster they currently sit in and placed together in their OWN
    // dedicated group that BYPASSES the formation gate. This is what lets an editor
    // carve a distinct sub-story out of a big umbrella cluster (the evict-then-merge
    // flow, or a direct merge) and stand up a story from just 2 sources — or even
    // attach-only / adversary items — when the editor says so. The formation gate
    // stays fully in force for everything automatic (and for soft "link"s); it is
    // ONLY the explicit human merge that overrides it. Fail-closed / curated-lane
    // only: this writes solely to curated_cluster_members and can NEVER surface in
    // the main / Classic / Visual / custom-MCOP feeds or the public API.
    // -------------------------------------------------------------------------
    const manualMergeKeyGroupsRaw: string[][] = manualLinks
      .filter(ml => ml.kind === 'merge')
      .map(ml =>
        Array.from(
          new Set(
            (ml.memberUrls ?? [])
              .map(u => urlToKey.get(normalizeMemberUrl(u)))
              .filter((k): k is string => !!k),
          ),
        ),
      )
      .filter(g => g.length >= 2);
    // CONSOLIDATE overlapping forced groups (see consolidateForcedMergeGroups):
    // overlapping merge rows — and soft links that intersect them — must act as
    // ONE story. Without this, the first forced group claims shared keys and a
    // retry merge PARTITIONS the story into two clusters. Soft-link key groups
    // are index-aligned with manualLinks, so filter by kind here.
    const manualSoftLinkKeyGroups: string[][] = manualLinks
      .map((ml, i) => (ml.kind === 'merge' ? [] : manualLinkKeyGroupsAll[i] ?? []))
      .filter(g => g.length >= 2);
    const manualMergeKeyGroups = consolidateForcedMergeGroups(
      manualMergeKeyGroupsRaw,
      manualSoftLinkKeyGroups,
    );
    if (
      manualMergeKeyGroupsRaw.length > 0 &&
      manualMergeKeyGroups.length < manualMergeKeyGroupsRaw.length
    ) {
      console.log(
        `[CuratedCluster] Editor manual-MERGE consolidation: ${manualMergeKeyGroupsRaw.length} overlapping ` +
          `merge row(s) unioned into ${manualMergeKeyGroups.length} forced story group(s)`,
      );
    }
    const forcedMergeGroups = new Set<SplitAppliedGroup>();
    if (manualMergeKeyGroups.length > 0) {
      const forcedKeys = new Set<string>(manualMergeKeyGroups.flat());
      // 1) Release every forced-merge member from any group it currently sits in
      //    (the umbrella / other cluster), so the merge owns them exclusively.
      for (const g of orderedGroups) {
        g.keys = g.keys.filter(k => !forcedKeys.has(k));
      }
      // 2) Prepend each merge set as its OWN dedicated group so it is processed
      //    FIRST and claims its members before any overlapping group can.
      const forced: SplitAppliedGroup[] = manualMergeKeyGroups.map(keys => ({ keys: [...keys] }));
      for (const fg of forced) forcedMergeGroups.add(fg);
      orderedGroups.unshift(...forced);
      console.log(
        `[CuratedCluster] Editor manual-MERGE carve-out: ${forced.length} dedicated story group(s) forced ` +
          `(pulled from any host cluster; formation gate bypassed for the editor's explicit decision)`,
      );
    }

    // -------------------------------------------------------------------------
    // PHASE A (Task #301) — SELECT the stories that form this pass. Identical
    // gates + representative selection as before; only id assignment and member/
    // synthesis row construction are DEFERRED to Phase B so a churning story can
    // reclaim its prior-pass clusterId.
    // -------------------------------------------------------------------------
    interface PendingStory {
      groupNodes: LaneNode[];
      representative: LaneNode;
      // The node used for stable identity/synthesis may fall back to any member
      // for an editor-forced all-attach merge. Story media may not: social posts
      // are Additional Coverage only, even under a forced merge.
      storyRepresentativeKey: string | null;
      tokens: string[]; // member signature tokens (natural-hash input)
      headTokens: Set<string>; // representative title tokens (match guard)
      category: string | null; // representative category (match veto)
      repUrl: string | null; // representative url (region veto + overlay key)
      splitLineageKey: string | null; // re-partition child lineage (archive isolation)
    }
    const pending: PendingStory[] = [];

    // Distinct-publisher identity for the formation gate below. The same ARTICLE
    // can survive as two nodes when URL dedup missed it — a main:<id> + curated:<id>
    // clone whose stored URLs differ only by query/protocol, or one outlet re-running
    // the same wire. Such copies share a publisher and must NOT count as multi-source
    // corroboration. The distinct-publisher accounting lives in evaluateFormation
    // (publisherKeyOf): domain is the robust outlet key (ignores path/query variance),
    // falling back to the source name, else the node key so a genuinely unidentifiable
    // node still counts as its own publisher (never over-collapses distinct outlets).
    for (const group of orderedGroups) {
      const groupNodes = group.keys
        .filter(k => !assignedKeys.has(k))
        .map(k => nodeByKey.get(k))
        .filter((n): n is LaneNode => !!n);
      if (groupNodes.length < 2) continue;

      // An explicit editor MERGE (carve-out above) overrides the automatic gates:
      // the formation gate AND the staleness phase-out are both bypassed for it,
      // because a human deliberately declared these items to be one story.
      const isForcedMerge = forcedMergeGroups.has(group);

      const corroborating = groupNodes.filter(n => n.cls === 'corroborating');
      // FORMATION GATE (evaluateFormation — the SAME pure logic the #604 regression
      // test pins): a story forms only with >= 2 CORROBORATING items from >= 2
      // DISTINCT PUBLISHERS. Anchor-only / attach items carry NO formation weight,
      // and N copies of ONE outlet (a clone that escaped URL dedup, or one outlet's
      // repeated wire) count as a SINGLE source — so they can never stand up a fake
      // "2-source" story or inflate sourceCount. An explicit editor merge is exempt.
      if (!isForcedMerge && !evaluateFormation(groupNodes).forms) continue;

      // Staleness phase-out (Task #177): a cluster is dropped once its origination
      // ages out, EVEN if its source items are still inside the 24h live ingestion
      // window. Applying the same gate here (not only in carry-over) enforces the
      // 22h hard cap uniformly, so a brand-new cluster built from live items aged
      // 22-24h cannot slip through. Mirrors the carry-over decision exactly.
      const groupPubTimes = groupNodes
        .map(n => (n.publishedAt ? new Date(n.publishedAt).getTime() : NaN))
        .filter(t => Number.isFinite(t)) as number[];
      if (
        !isForcedMerge &&
        isClusterPhasedOut(groupPubTimes, nowMs, {
          developingProcess: isDevelopingProcessCluster(groupNodes.map(n => n.title)),
          lastContributingMs: lastContributingMs(groupNodes),
        })
      )
        continue;

      // Representative selection:
      //   1. A PRIMARY anchor-only item (official Social/Release) is the origin of
      //      the news, so it anchors the headline ("X announced…") when present.
      //   2. Otherwise the highest-priority CORROBORATING news item.
      // A CONTRAST anchor-only item (adversary / low-factuality) NEVER anchors.
      const primaries = groupNodes.filter(n => n.cls === 'anchor-only' && n.label === 'primary');
      // Among corroborating items, prefer a real reported ARTICLE over a
      // video/opinion piece. The representative is the cluster's "face" (its url,
      // thumbnail and content-kind badge), so a video rep made an entire
      // multi-source news story render as a single "Video". Fall back to a
      // video/opinion only when nothing else corroborates. Primary-origin anchors
      // (official Social/Release) keep priority order — they ARE the origin.
      // Normal groups always have >= 2 corroborating members (formation gate),
      // so this only ever falls back to the full node set for a FORCED editor
      // merge whose members are all attach-only / contrast — the editor's choice
      // must still get a face rather than crashing on an empty pool.
      const nonSocialNodes = groupNodes.filter(n => !n.isSocialFlash);
      const repPool = primaries.length
        ? primaries
        : (corroborating.length ? corroborating : (nonSocialNodes.length ? nonSocialNodes : groupNodes));
      // A real reported ARTICLE (not video/opinion by URL, not a stored audio
      // podcast or a page-labeled ANALYSIS/OPINION piece — Task #650) is
      // preferred as the cluster's face. isEffectivelyReportedArticle combines
      // the URL shape with the page-detected signal so a trusted outlet's
      // "Analysis" piece can't become the rep just because its URL looks like
      // a plain article.
      const reportedArticles = repPool.filter(n => isEffectivelyReportedArticle(n.url, n.contentKind as any, n.title));
      const repCandidates = reportedArticles.length ? reportedArticles : repPool;
      // Seeding gate (Task #231): prefer a FULLY ENRICHED candidate as the
      // cluster's face (real headline + bullets + real image). Fall back to the
      // best available when none qualify — a formed multi-source story must
      // NEVER be dissolved just because enrichment hasn't landed yet (the read
      // path still overlays the best image across all members).
      const enrichedCandidates = repCandidates.filter(isNodeFullyEnriched);
      const representative = (enrichedCandidates.length ? enrichedCandidates : repCandidates)
        .sort((a, b) => b.priority - a.priority)[0];
      const storyRepresentativeKey = representative.isSocialFlash ? null : representative.key;

      // Claim this story's items now so later overlapping groups exclude them, and
      // count it — id assignment + row construction happen in Phase B.
      for (const n of groupNodes) assignedKeys.add(n.key);
      stories++;
      pending.push({
        groupNodes,
        representative,
        storyRepresentativeKey,
        tokens: groupNodes.map(n => memberSignatureToken(n.url, n.key)),
        headTokens: significantTitleTokens(representative.title),
        category: representative.category ?? null,
        repUrl: representative.url ?? null,
        splitLineageKey: group.splitLineageKey ?? null,
      });
    }

    // -------------------------------------------------------------------------
    // POST-FORMATION SEMANTIC ADVERSARY-ANGLE ATTACH. Add the MISSING adversary /
    // state-media angles to each formed story by MEANING (not shared words), so a
    // big story shows several contrasting state-media takes instead of only the
    // one that happened to token-match. Mutates pending[].groupNodes in place and
    // claims the attached keys BEFORE Phase B reads them, while p.tokens (the
    // clusterId signature, captured above) stays trusted-only so identity is
    // stable. Fail-closed + curated-lane only (see fn doc). Never throws.
    // -------------------------------------------------------------------------
    // Semantic adversary-angle attach (LLM) — skipped on re-shape. Task #645:
    // these keys are VOLATILE (LLM-decided each pass) so Phase B below marks
    // them provisional and gates their display on cross-pass confirmation.
    let semanticAttachedKeys = new Set<string>();
    if (mode !== 'reshape') {
      // PHASE BOUNDARY (Task #716): stop before the semantic adversary-attach
      // (bridge) LLM pass if the hard timeout has fired. Thrown OUTSIDE the
      // fail-safe try below so it propagates to the outer catch (preserves).
      throwIfClusterAborted(abortSignal, 'before-semantic-attach');
      try {
        const result = await semanticAttachAdversaryAngles(pending, candidateNodes, assignedKeys, evictedKeys, abortSignal);
        semanticAttachedKeys = result.attachedKeys;
      } catch (semErr) {
        console.warn(
          '[CuratedCluster] Semantic adversary attach pass errored (non-fatal):',
          semErr instanceof Error ? semErr.message : semErr,
        );
      }
    }

    // -------------------------------------------------------------------------
    // PHASE B (Task #301) — assign each formed story ONE STABLE clusterId and
    // build its member + synthesis rows under it. A story whose membership churned
    // since last pass reclaims its PRIOR clusterId when it clearly continues the
    // same story, so it keeps ONE synthesis row and ONE archive row instead of
    // leaving a phantom "phased out" duplicate behind under the old member-set
    // hash. Otherwise it falls back to its natural hash (today's behavior). The
    // reuse is guarded so two distinct concurrent stories can never collapse onto
    // one id: a region OR category conflict vetoes, and a positive needs strong
    // member-set overlap or a closely matching headline.
    // -------------------------------------------------------------------------
    // Region overlay for the veto — the SAME URL-keyed source the archive layer
    // uses. Loaded once for every representative URL across new + prior stories.
    const regionLookupUrls = Array.from(
      new Set(
        [...pending.map(p => p.repUrl), ...priorIdentities.map(pi => pi.repUrl)].filter(
          (u): u is string => !!u,
        ),
      ),
    );
    let regionByUrl = new Map<string, string | null>();
    try {
      const clsMap = await storage.getCuratedClassificationsByUrls(regionLookupUrls);
      regionByUrl = new Map(Array.from(clsMap.entries()).map(([u, c]) => [u, c.region ?? null]));
    } catch (regionErr) {
      console.warn(
        '[CuratedCluster] region overlay load failed (non-fatal):',
        regionErr instanceof Error ? regionErr.message : regionErr,
      );
    }
    const regionOf = (url: string | null): string | null =>
      url ? (regionByUrl.get(url) ?? null) : null;

    const usedPriorIds = new Set<string>();
    const usedStableIds = new Set<string>();
    // Re-partition lineage keyed by the FINAL stableId so archiveFormedStories can
    // stamp each child's archive row — sibling children never carry-forward-merge.
    const lineageByStableId = new Map<string, string | null>();
    for (const p of pending) {
      const naturalSig = synthesisSignature(p.tokens);
      const newTokens = new Set(p.tokens);
      const newRegion = regionOf(p.repUrl);
      // Best UNUSED prior identity that clearly continues this story. The match
      // decision (category/region veto + member-set/headline overlap) lives in
      // the pure, exported priorIdentityMatchScore helper so it's regression
      // testable; null means "not a continuation" (distinct concurrent story).
      let best: (typeof priorIdentities)[number] | null = null;
      let bestScore = -1;
      for (const pi of priorIdentities) {
        if (usedPriorIds.has(pi.clusterId)) continue;
        const score = priorIdentityMatchScore(
          { tokens: newTokens, headTokens: p.headTokens, category: p.category, region: newRegion },
          {
            tokens: new Set(pi.tokens),
            headTokens: pi.headTokens,
            category: pi.category,
            region: regionOf(pi.repUrl),
          },
        );
        if (score == null) continue;
        if (score > bestScore) {
          bestScore = score;
          best = pi;
        }
      }
      let stableId = naturalSig;
      if (best && !usedStableIds.has(best.clusterId)) {
        stableId = best.clusterId;
        usedPriorIds.add(best.clusterId);
      }
      // Collision guard: never assign one id to two stories this pass (would merge
      // their members + collide as React keys). Natural hashes are unique per
      // distinct member set, so fall back to it.
      if (usedStableIds.has(stableId)) stableId = naturalSig;
      usedStableIds.add(stableId);
      lineageByStableId.set(stableId, p.splitLineageKey ?? null);

      const { groupNodes, representative, storyRepresentativeKey } = p;
      for (const n of groupNodes) {
        members.push({
          clusterId: stableId,
          itemType: n.itemType,
          itemId: n.itemId,
          role: n.role,
          // Display trust-tier (Task #121): persist the behavior class+label
          // computed live here so the detail-view bucketing (corroborating /
          // primary-origin / contrast / attach) matches formation truth instead
          // of re-deriving from the registry (which fails closed to attach).
          behaviorClass: n.cls,
          behaviorLabel: n.label,
          // Page-detected content kind (Task #650) snapshotted so a demoted
          // opinion/analysis member keeps its badge in the attach area.
          contentKind: n.contentKind ?? null,
          title: n.title,
          source: n.source,
          url: n.url,
          category: n.category ?? null,
          summary: n.summary ?? null,
          publishedAt: n.publishedAt,
          priorityScore: n.priority,
          ogImageUrl: n.ogImageUrl,
          isRepresentative: storyRepresentativeKey !== null && n.key === storyRepresentativeKey,
          // Cross-pass member-confirmation hysteresis (Task #645): the semantic
          // adversary-attach pass is volatile (LLM re-decides every pass), so
          // its additions start provisional/unconfirmed. Phase-A core members
          // (trusted corroboration) are never provisional. confirmedStreak is
          // filled in below once the true clusterId (stableId) is known.
          provisional: semanticAttachedKeys.has(n.key),
          confirmedStreak: 0,
        });
      }

      formedStories.push({
        signature: stableId,
        synthMembers: groupNodes.map(n => ({
          key: n.key,
          url: n.url,
          source: n.source,
          sourceIdentifier: n.sourceIdentifier,
          factuality: n.factuality,
          ownership: n.ownership,
          title: n.title,
          summary: n.summary,
          bullets: n.bullets,
          cls: n.cls,
          label: n.label,
          // Prompt-display only — see SynthMember.publishedAt for the invariant
          // that this must never enter any signature or hash.
          publishedAt: n.publishedAt,
        })),
      });
    }

    // Same-event duplicate reconciliation now happens PRE-formation in the
    // unified consolidation lane (buildSameEventMergeComponents) — the former
    // post-formation one-merge-per-pass backstop (Task #1085) is gone. The
    // flight-recorder metric keeps its column but now counts every component
    // that merged or re-shaped a formable group this pass (0..budget), a richer
    // signal than the old 0/1.
    const missedMergeReconciled = sameEventGroupMerges;

    // ----------------------------------------------------------------------
    // Synthesis pass (Task #90). OFF the hot path: runs here in the cron. Keyed
    // by content SIGNATURE so an unchanged story reuses its cached synthesis (no
    // LLM call) and only re-synthesizes when its membership actually changes.
    // Wrapped so it can NEVER break clustering.
    //
    // Runs BEFORE membership is persisted (Task #362) so a detected FALSE-MERGE
    // cluster — one whose corroborated facts each trace to a single
    // independently-owned source — is DISSOLVED: its members are released from
    // the write so the items fall back to stand-alone cards instead of a bogus
    // single corroborated Top Story. Synthesis only reads/writes its own cache
    // (never the members table), so this reorder is safe.
    // ----------------------------------------------------------------------
    let dissolvedSignatures = new Set<string>();
    // Synthesis (LLM, signature-cached) — normally skipped on re-shape. The
    // reused stories keep their EXISTING cached synthesis (resolved by stable
    // clusterId at read time), so an ordinary re-shape adds no synthesis cost
    // and surfaces no new false-merges (the full pass that formed the grouping
    // already did). forceSynthesis (Task #660) is set by the editor
    // link/merge commit path: that reshape mints a NEW clusterId for the
    // merged/linked story (no existing synthesis cache entry can match it), so
    // it opts back into this bounded, signature-cached pass so the headline +
    // key facts regenerate immediately — every OTHER unchanged story is still
    // a pure cache hit. Editor-forced members are exempt from the false-merge
    // dissolution verdict here (manualLinkProtectedKeys).
    if (mode !== 'reshape' || forceSynthesis) {
      // PHASE BOUNDARY (Task #716): stop before the synthesis LLM pass if the
      // hard timeout has fired. Thrown OUTSIDE the fail-safe try below so it
      // propagates to the outer catch (preserves existing clusters, no wipe).
      throwIfClusterAborted(abortSignal, 'before-synthesis');
      try {
        dissolvedSignatures = await synthesizeFormedStories(formedStories, manualLinkProtectedKeys, abortSignal, passDeadlineAtMs);
      } catch (error) {
        console.error('[CuratedCluster] Synthesis pass failed (non-fatal):', error);
      }
    }

    // Anchor-aware event-identity backstop (attach-vs-spawn). Runs AFTER synthesis
    // has produced each formed story's neutral anchor, releasing any member whose
    // OVERARCHING TOPIC is a genuinely DIFFERENT event so it falls back to a
    // stand-alone card (next pass's grouping re-clusters it). Conservative +
    // fail-open + can never dissolve a cluster (see anchorAwareSplitFormedStories).
    // It may also flip a story's dissolved verdict when shrinking reveals/repairs
    // a false merge, so merge those deltas into the dissolved set below.
    let releasedKeys = new Set<string>();
    // Flight-recorder: anchor-split backstop behavior this pass (defaults to
    // zeros if the backstop is disabled or throws — fail-open).
    let splitAudited = 0;
    let splitReleased = 0;
    let splitVetoes = 0;
    let splitDevelopingSkips = 0;
    let splitReleaseCapClamps = 0;
    let splitOversizedEscapes = 0;
    let splitOversizedReleased = 0;
    // Anchor-split backstop (LLM event-identity classifier) — skipped on re-shape.
    if (mode !== 'reshape') {
      // PHASE BOUNDARY (Task #716): stop before the anchor-split LLM backstop if
      // the hard timeout has fired. Thrown OUTSIDE the fail-safe try below so it
      // propagates to the outer catch (preserves existing clusters, no wipe).
      throwIfClusterAborted(abortSignal, 'before-anchor-split');
      try {
        const split = await anchorAwareSplitFormedStories(formedStories, manualLinkProtectedKeys, abortSignal);
        releasedKeys = split.releasedKeys;
        for (const sig of split.dissolvedAdds) dissolvedSignatures.add(sig);
        for (const sig of split.dissolvedRemoves) dissolvedSignatures.delete(sig);
        splitAudited = split.audited;
        splitReleased = split.releasedCount;
        splitVetoes = split.vetoes;
        splitDevelopingSkips = split.developingProcessSkips;
        splitReleaseCapClamps = split.releaseCapClamps;
        splitOversizedEscapes = split.oversizedEscapes;
        splitOversizedReleased = split.oversizedReleased;
      } catch (error) {
        console.error('[CuratedCluster] Anchor-split backstop failed (non-fatal):', error);
      }
    }

    const dissolvedClusterIds = new Set(
      members.filter(m => dissolvedSignatures.has(m.clusterId)).map(m => m.clusterId),
    );
    // Drop dissolved clusters entirely AND any individual members released by the
    // anchor-split backstop (keyed by `${itemType}:${itemId}` to match the synthesis
    // member key). Released members never remove a whole story — the kept set still
    // forms — so the story count only decreases for dissolved clusters.
    const keptMembers = (dissolvedClusterIds.size || releasedKeys.size)
      ? members.filter(
          m =>
            !dissolvedClusterIds.has(m.clusterId) &&
            !releasedKeys.has(`${m.itemType}:${m.itemId}`),
        )
      : members;
    const keptStories = stories - dissolvedClusterIds.size;

    // Fail-closed: a re-shape must NEVER wipe the lane. If it somehow produced no
    // members (e.g. everything aged out this tick), leave the existing clusters
    // intact for the next full cron pass instead of clearing Top Stories.
    if (mode === 'reshape' && keptMembers.length === 0) {
      console.warn('[CuratedCluster] re-shape produced 0 members — preserving existing clusters');
      return { stories: 0, members: 0 };
    }

    // -------------------------------------------------------------------------
    // CROSS-PASS MEMBER-CONFIRMATION HYSTERESIS (Task #645). A provisional
    // member (currently: semantic adversary-attach) only reads its persisted
    // streak here — its confirmedStreak stamped on the row is what the read
    // path (routes.ts) gates display on. Non-provisional (Phase-A core) members
    // are always displayed regardless of streak and are never bumped/pruned, so
    // the trusted corroborating core is unaffected by this bookkeeping. Prune
    // sweeps every confirmation whose key isn't provisional-active THIS pass,
    // so a member that drops out (or gets promoted to core) resets to 0 instead
    // of resurrecting a stale streak on a later re-appearance. Fail-closed: any
    // bump/prune error leaves confirmedStreak at 0 (still withheld) rather than
    // risking a false confirmation.
    const provisionalActiveKeys: string[] = [];
    for (const m of keptMembers) {
      if (!m.provisional) continue;
      const key = `${m.clusterId}:${m.itemType}:${m.itemId}`;
      provisionalActiveKeys.push(key);
      try {
        m.confirmedStreak = await storage.bumpCuratedMemberConfirmation(m.clusterId, m.itemType, m.itemId);
      } catch (confirmErr) {
        console.warn(
          '[CuratedCluster] Member-confirmation bump failed (non-fatal, stays withheld):',
          confirmErr instanceof Error ? confirmErr.message : confirmErr,
        );
        m.confirmedStreak = 0;
      }
    }
    try {
      await storage.pruneCuratedMemberConfirmations(provisionalActiveKeys);
    } catch (pruneErr) {
      console.warn(
        '[CuratedCluster] Member-confirmation prune failed (non-fatal):',
        pruneErr instanceof Error ? pruneErr.message : pruneErr,
      );
    }

    // FINAL preserve-before-write checkpoint. Abort checks otherwise only sit at
    // phase boundaries; an editor-yield (or hard-timeout) abort that lands AFTER
    // the last boundary would otherwise still reach this destructive rebuild.
    // Throwing here guarantees the documented contract: an aborted pass NEVER
    // persists a partial/empty member set — the prior clusters stay intact.
    throwIfClusterAborted(abortSignal, 'before-member-write');
    await storage.replaceCuratedClusterMembers(keptMembers);
    // Classification is display metadata over the authoritative member snapshot.
    // Trigger a coalesced visible-first pass immediately after replacement rather
    // than waiting up to ten minutes for the cron.
    void import('./curatedClassify')
      .then(({ scheduleCuratedClassificationBackfill }) => scheduleCuratedClassificationBackfill())
      .catch((error) => console.warn('[CuratedCluster] Classification follow-up scheduling failed:', error));
    console.log(
      `[CuratedCluster] ${mode === 'reshape' ? 'Re-shape' : 'Done'} — formed ${keptStories} stories, ${keptMembers.length} members` +
        (dissolvedClusterIds.size ? ` (dissolved ${dissolvedClusterIds.size} likely false-merge cluster(s))` : ''),
    );

    // AUTHORITATIVE OUTCOME OBSERVATION (Task #1180). Immediately after the
    // destructive member write, in FULL authoritative mode ONLY, observe whether
    // the small set of UNSETTLED + RECENT editorial episodes actually took effect
    // in the final kept membership + priority state. This is deliberately gated to
    // a full pass: a cheap deterministic re-shape reuses the prior grouping and is
    // NOT an authoritative recompute, so treating its result as an "applied"
    // signal would be misleading — a re-shape may still record an IMMEDIATE
    // observation via a separate call, clearly distinguished by mode. The storage
    // worker is bounded, serialized, and coalescing, so this can never extend or
    // break a pass. Curated-lane only; never writes a human pin or outlet role.
    if (mode !== 'reshape') {
      const outcomeStartedAt = Date.now();
      curatedEditorialOutcomeQueue.enqueue(
        'clustering',
        {
          // The monotonic per-pass run token is a unique, idempotent revision key:
          // a retried/re-run pass upserts the same per-episode observation instead
          // of double-counting.
          clusterRevision: `full:${myRunToken}`,
          keptMembers,
          mode: 'full',
          latencyMs: Date.now() - outcomeStartedAt,
        },
        (outcomeSummary) => {
          if (outcomeSummary.scanned <= 0) return;
          console.log(
            `[CuratedCluster] Editorial-outcome observation: scanned ${outcomeSummary.scanned} active episode(s) — ` +
              `applied=${outcomeSummary.applied} deferred=${outcomeSummary.deferred} conflicted=${outcomeSummary.conflicted} ` +
              `dormant=${outcomeSummary.dormant} superseded=${outcomeSummary.superseded} undone=${outcomeSummary.undone} ` +
              `failed=${outcomeSummary.failed} (${outcomeSummary.latencyMs}ms)`,
          );
        },
      );
    }

    // ----------------------------------------------------------------------
    // Archive pass. Snapshots each FORMED+synthesized story into the historical
    // curated_story_archive table so it survives the per-pass member wipe. Runs
    // AFTER synthesis (reads the freshly-written synthesis cache) and over the
    // KEPT members only so a dissolved false merge is never archived. Wrapped so
    // it can NEVER break clustering. Curated-lane only — never touches shared feeds.
    // ----------------------------------------------------------------------
    let archiveMetrics: CuratedArchiveMetrics = {
      rowsSeen: 0,
      exactUpdates: 0,
      carryForwardMerges: 0,
      inserted: 0,
      absorbedDuplicates: 0,
      skippedUnsynthesized: 0,
    };
    try {
      archiveMetrics = await archiveFormedStories(keptMembers, lineageByStableId);
    } catch (error) {
      console.error('[CuratedCluster] Archive pass failed (non-fatal):', error);
    }

    // ----------------------------------------------------------------------
    // Flight recorder. Append exactly ONE row per pass capturing the SHAPE of
    // what shipped (cluster size distribution + developing-process count) plus
    // the refinement-backstop behavior (anchor-split + dissolutions) and the
    // archive churn. Pure observability — wrapped so a metrics failure can NEVER
    // break a clustering pass. Curated-lane only; read by the curated-gated
    // /api/curated/cluster-metrics endpoint.
    // ----------------------------------------------------------------------
    try {
      // Size distribution over the KEPT clusters (what actually shipped).
      const sizeByCluster = new Map<string, number>();
      const titlesByCluster = new Map<string, string[]>();
      for (const m of keptMembers) {
        sizeByCluster.set(m.clusterId, (sizeByCluster.get(m.clusterId) ?? 0) + 1);
        const t = titlesByCluster.get(m.clusterId) ?? [];
        t.push(m.title);
        titlesByCluster.set(m.clusterId, t);
      }
      const sizes = Array.from(sizeByCluster.values()).sort((a, b) => a - b);
      const pct = (p: number) =>
        sizes.length === 0 ? 0 : sizes[Math.min(sizes.length - 1, Math.floor((p / 100) * sizes.length))];
      const median = sizes.length === 0
        ? 0
        : sizes.length % 2
          ? sizes[(sizes.length - 1) / 2]
          : Math.round((sizes[sizes.length / 2 - 1] + sizes[sizes.length / 2]) / 2);
      let developingProcessClusters = 0;
      for (const titles of Array.from(titlesByCluster.values())) {
        if (isDevelopingProcessCluster(titles)) developingProcessClusters++;
      }

      // Suspected MISSED-corroboration alarm (Task #626, Task #1025). Every
      // corroborating candidate node that did NOT land in a formed cluster this pass
      // is a STANDALONE Top Story. Flag any group of them that looks like the same
      // event (high-precision title similarity + same-event window) drawn from
      // >= 2 distinct publishers — i.e. a story that SHOULD have merged but the
      // (non-deterministic) LLM grouping stage failed to group.
      //
      // Task #1025 addition: groups that were already fed into the fuzzy missed-merge
      // must-link this pass (and therefore judged by the formation gate) but STILL
      // didn't form are marked "ruled out" in judgedMissedMergePairs and suppressed
      // from the alarm count so the same group doesn't repeat every pass. Suppression
      // expires after JUDGED_PAIR_TTL_MS so a genuinely new story is never silenced.
      let suspectedMissedMerges = 0;
      let suspectedMissedMergeSamples: string | null = null;
      try {
        // Prune expired entries from the judged-pairs cache before use.
        const nowForJudge = Date.now();
        for (const [k, exp] of Array.from(judgedMissedMergePairs.entries())) {
          if (exp <= nowForJudge) judgedMissedMergePairs.delete(k);
        }

        const clusteredKeys = new Set(keptMembers.map(m => `${m.itemType}:${m.itemId}`));
        const standaloneNodes = candidateNodes.filter(
          n => n.cls === 'corroborating' && !n.blocked && !clusteredKeys.has(n.key),
        );
        const flagged = findSuspectedMissedMerges(standaloneNodes);

        // Filter out groups whose every representative pair is either already judged
        // (ruled out) or was fed into fuzzy must-link this pass (judged this cycle).
        // A group still appearing after being judged this cycle earns a ruled-out
        // stamp below so it won't alarm on the next pass either.
        const genuinelyNewFlagged = flagged.filter(g => {
          const pairsInGroup: string[] = [];
          for (let i = 0; i < g.keys.length; i++) {
            for (let j = i + 1; j < g.keys.length; j++) {
              pairsInGroup.push([g.keys[i], g.keys[j]].sort().join('|'));
            }
          }
          // Suppress if ALL pairs of this group are ruled out (previously judged).
          return !pairsInGroup.every(ph => judgedMissedMergePairs.has(ph));
        });

        suspectedMissedMerges = genuinelyNewFlagged.length;

        // Stamp as "ruled out" any pairs that were judged by fuzzy must-link this
        // pass but still appear in the post-pass alarm (formation gate rejected them).
        // These pairs won't alarm for JUDGED_PAIR_TTL_MS.
        const stillStandaloneUrls = new Set(standaloneNodes.map(n => n.key));
        for (const group of sameEventMergeGroups) {
          const allStillStandalone = group.every(k => stillStandaloneUrls.has(k));
          if (allStillStandalone) {
            const expiresAt = nowForJudge + JUDGED_PAIR_TTL_MS;
            for (let i = 0; i < group.length; i++) {
              for (let j = i + 1; j < group.length; j++) {
                const ph = [group[i], group[j]].sort().join('|');
                judgedMissedMergePairs.set(ph, expiresAt);
              }
            }
          }
        }
        if (judgedMissedMergePairs.size > 0 && flagged.length > genuinelyNewFlagged.length) {
          console.log(
            `[CuratedCluster] Missed-corroboration alarm: ${flagged.length} raw group(s), ` +
            `${flagged.length - genuinelyNewFlagged.length} suppressed (judged/ruled-out), ` +
            `${genuinelyNewFlagged.length} genuinely new`,
          );
        }

        if (genuinelyNewFlagged.length > 0) {
          // Bound the stored/logged snapshot so a busy pass can't bloat the row:
          // first 10 groups, each group's first 4 titles.
          const sample = genuinelyNewFlagged.slice(0, 10).map(g => ({
            publishers: g.publishers,
            titles: g.titles.slice(0, 4),
          }));
          suspectedMissedMergeSamples = JSON.stringify(sample);
          console.warn(
            `[CuratedCluster] Suspected missed corroboration: ${genuinelyNewFlagged.length} standalone group(s) ` +
              `look like the same event across >= 2 publishers but did NOT merge. Samples: ${suspectedMissedMergeSamples}`,
          );
        }
      } catch (missedErr) {
        console.warn(
          '[CuratedCluster] Missed-corroboration diagnostic failed (non-fatal):',
          missedErr instanceof Error ? missedErr.message : missedErr,
        );
      }

      await storage.recordCuratedClusterMetrics({
        refinementTag: mode === 'reshape' ? 'reshape' : (process.env.CURATED_REFINEMENT_TAG ?? null),
        formedStories: keptStories,
        totalMembers: keptMembers.length,
        maxClusterSize: sizes.length ? sizes[sizes.length - 1] : 0,
        medianClusterSize: median,
        p95ClusterSize: pct(95),
        largeClusters: sizes.filter(s => s > 20).length,
        developingProcessClusters,
        unsynthesizedFormedStories: archiveMetrics.skippedUnsynthesized,
        falseMergeDissolutions: dissolvedClusterIds.size,
        anchorSplitAudited: splitAudited,
        anchorSplitReleased: splitReleased,
        anchorSplitVetoes: splitVetoes,
        anchorSplitDevelopingSkips: splitDevelopingSkips,
        anchorSplitOversizedEscapes: splitOversizedEscapes,
        anchorSplitOversizedReleased: splitOversizedReleased,
        releaseCapClamps: splitReleaseCapClamps,
        archiveRowsSeen: archiveMetrics.rowsSeen,
        archiveExactUpdates: archiveMetrics.exactUpdates,
        archiveCarryForwardMerges: archiveMetrics.carryForwardMerges,
        archiveInserted: archiveMetrics.inserted,
        archiveAbsorbedDuplicates: archiveMetrics.absorbedDuplicates,
        archiveSkippedUnsynthesized: archiveMetrics.skippedUnsynthesized,
        smartRepartitionAudited: repartitionAudited,
        smartRepartitionTriggered: repartitionTriggered,
        smartRepartitionCacheHits: repartitionCacheHits,
        smartRepartitionChildrenCreated: repartitionChildrenCreated,
        smartRepartitionMembersMoved: repartitionMembersMoved,
        smartRepartitionFailed: repartitionFailed,
        smartRepartitionCooldownSkipped: repartitionCooldownSkipped,
        preventionRepartitionAudited,
        preventionRepartitionTriggered,
        preventionRepartitionChildrenCreated,
        suspectedMissedMerges,
        suspectedMissedMergeSamples,
        missedMergeReconciled,
      });
    } catch (error) {
      console.error('[CuratedCluster] Flight-recorder metrics write failed (non-fatal):', error);
    }

    return { stories: keptStories, members: keptMembers.length };
  } catch (error) {
    // Task #716: an AbortError means the pass hit its hard-timeout early-stop at
    // a phase boundary BEFORE the destructive replaceCuratedClusterMembers write,
    // so returning here PRESERVES the existing clusters (never wipes) — the same
    // fail-safe contract as an all-providers AI timeout. Log it as a warning, not
    // a fatal error, so it's distinguishable from a genuine crash.
    if ((error as { name?: string })?.name === 'AbortError') {
      console.warn(
        '[CuratedCluster] Pass cancelled early by hard-timeout signal — stopped queueing new AI work, preserving existing clusters:',
        error instanceof Error ? error.message : error,
      );
    } else {
      console.error('[CuratedCluster] Fatal error:', error);
    }
    return { stories: 0, members: 0 };
  } finally {
    clearTimeout(abortTimer);
    // Release the editor-yield hook if it still points at THIS pass (a newer full
    // pass may have replaced it — never null out someone else's controller).
    if (currentFullPassAbort === abortController) currentFullPassAbort = null;
    // Only release the guard if a newer pass hasn't already reclaimed it (Task
    // #741). If this pass was declared stale/abandoned and a fresh pass took over,
    // clusteringRunToken has advanced past ours — clearing the guard now would
    // yank the lock out from under the running pass. In that case we do nothing;
    // the current owner will release its own guard and fire any pending reshape.
    if (clusteringRunToken === myRunToken) {
      // Curated AI spend telemetry (Task #1100): emit the per-family per-pass
      // summary lines BEFORE releasing the lock, so a deferred manual re-shape
      // fired below accumulates into its OWN flush, not this pass's. Log-only.
      flushCuratedAiSpendTelemetry(forceSynthesis ? `${mode}+synthesis` : mode);
      isClusteringRunning = false;
      clusteringStartedAt = null;
      // If a manual link/merge arrived while this pass held the lock, fire the
      // deferred re-shape NOW (the lock is free again). This guarantees the merge
      // lands instantly after the pass, never waiting for the next ~5-min cron.
      kickManualReshapeDrain();
    }
  }
}

/**
 * Cheap, DETERMINISTIC curated re-shape (Task #430 follow-up). Re-runs the
 * curated lane's deterministic stages — carry-over, URL dedup, identical-title
 * must-link, persisted split-overlay apply, formation gate, representative
 * ("face") selection, decay/age-out, archive carry-forward, metrics — over the
 * EXISTING grouping from the previous pass, WITHOUT any of the four expensive
 * LLM passes (grouping, coherence guard, AI re-partition, semantic adversary
 * attach) and without re-synthesis or the anchor-split backstop. Zero new AI
 * cost. It self-heals the visible lane between the scheduled full passes: a
 * freshly-enriched real image becomes the story face, a dead/placeholder/video
 * rep is swapped for a live reported article, stale stories age out, and
 * identical-title syndication merges — but it never DISCOVERS new clusters (that
 * needs the full pass). Fail-closed: with no prior grouping to re-shape, or if a
 * pass would leave the lane empty, it no-ops WITHOUT wiping. Routes through the
 * SAME single in-flight guard (isClusteringRunning) as the cron + manual full
 * pass, so it can never overlap them. CURATED-LANE ONLY.
 */
export async function reshapeCuratedLane(
  opts: { forceSynthesis?: boolean; maxDurationMs?: number } = {},
): Promise<{ stories: number; members: number; skipped?: boolean }> {
  return clusterCuratedLane({ mode: 'reshape', forceSynthesis: opts.forceSynthesis, maxDurationMs: opts.maxDurationMs });
}

// Synthesize each FORMED story, reusing the signature-keyed cache so unchanged
// stories don't pay for a fresh LLM call. Stale rows (signatures no longer
// present) are pruned. Sequential to stay gentle on the OpenAI rate limit.
// Returns the set of story signatures (= clusterIds) detected as LIKELY FALSE
// MERGES (Task #362) — corroborated=false. The caller releases their members so
// the items fall back to stand-alone cards instead of a bogus merged Top Story.
async function synthesizeFormedStories(
  formedStories: Array<{ signature: string; synthMembers: SynthMember[] }>,
  // Keys of nodes belonging to an ACTIVE editor manual-link (Task #660). A
  // story containing at least one such member is a DELIBERATE editor merge —
  // exempt it from the false-merge dissolution verdict below so this LATER,
  // separate AI backstop can never quietly tear apart a grouping the editor
  // forced (the editor's own concur/object second opinion already ran at
  // link time). The verdict is still computed and stored for observability —
  // only the dissolve ACTION is skipped.
  protectedKeys: Set<string> = new Set(),
  signal?: AbortSignal,
  // Deadline-aware synthesis (Task #1088). Absolute wall-clock (ms epoch) at
  // which the pass's hard-timeout AbortController fires. Before each synthesis
  // LLM call we check whether a worst-case call (AI_CALL_BACKSTOP_MS) could
  // still finish inside the budget — if not, the REMAINING stories are
  // deferred (cache untouched, sig still counted as used so nothing is
  // pruned) instead of launching a call that the abort will kill mid-flight
  // and whose spend is wasted. Curated-lane only; no deadline = old behavior.
  deadlineAtMs?: number,
): Promise<Set<string>> {
  const existing = await storage.getCuratedStorySynthesisMap();
  const usedSignatures: string[] = [];
  const dissolved = new Set<string>();
  let synthesized = 0;
  let reused = 0;
  let deferredCount = 0;
  let attempted = 0;
  // Bound provider pressure per pass while guaranteeing that never-synthesized
  // visible stories (tier 0 below) consume the budget first. Four calls drains
  // the current visible backlog without letting routine refreshes monopolize the
  // shared provider during a 429 storm.
  const MAX_SYNTHESIS_CALLS_PER_PASS = 4;
  // One provider chain must not monopolize the entire queue. This total budget is
  // shorter than the generic 75s per-attempt backstop and covers all fallbacks.
  const SYNTHESIS_STORY_BUDGET_MS = 60_000;

  // Synthesis-priority ordering (Task #1141). Under deadline pressure the tail
  // of this loop gets DEFERRED — so order it so deferral lands on stories that
  // already have a displayable cached headline, never on brand-new stories
  // (which would otherwise surface a single member's narrow angle as the card
  // headline). Tiers: 0 = never synthesized / no usable cached headline (must
  // run first), 2 = content-changed re-synthesis, 3 = everything else (one-time
  // backfills, stale-synopsis refreshes, and pure reuses — reuses never spend
  // budget, so their position is irrelevant). Ordering only; every per-story
  // reuse/defer/dissolve decision below is byte-identical. The contentHash is
  // computed once here and reused inside the loop.
  //
  // Anti-starvation promotion (tier 1): a strict 0→2→3 order would let
  // SUSTAINED tier-0/2 volume defer the tail's stale-synopsis refreshes and
  // one-time column backfills forever (they'd sit systematically last every
  // pass). So each pass promotes a BOUNDED handful of the most-overdue
  // likely-spend tier-3 rows to run right after the never-synthesized tier —
  // ahead of content-changed re-synthesis, which is safe to defer (it still
  // shows a real cached headline). The likely-spend predicate is deliberately
  // a cheap SUPERSET of the loop's re-synthesis triggers (null backfill
  // columns, or contributing content newer than the synthesized-through
  // marker, ignoring cooldowns): a promoted row the loop decides to reuse
  // costs nothing, so over-inclusion is harmless while under-inclusion would
  // reintroduce starvation. Bounded, so tier-0/2 work is delayed by at most
  // STARVATION_PROMOTE_CAP calls per pass.
  const STARVATION_PROMOTE_CAP = 3;
  const annotated = formedStories.map((story, idx) => {
    const cachedRow = existing.get(story.signature);
    const hash = synthesisContentHash(story.synthMembers);
    const tier = !cachedRow || !cachedRow.headline || !cachedRow.headline.trim()
      ? 0
      : cachedRow.contentHash !== hash
        ? 2
        : 3;
    // Overdue-ness for tier-3 promotion. Null-column backfills rank as
    // maximally overdue (they predate the marker entirely); otherwise the lag
    // between the freshest contributing content and what the synopsis was
    // built through. Non-positive lag (or a pure reuse) = not a candidate.
    let overdueMs = 0;
    if (tier === 3 && cachedRow) {
      const needsBackfill =
        cachedRow.attributedClaims == null || cachedRow.corroborated == null;
      const freshest = freshestContributingContentMs(story.synthMembers);
      if (needsBackfill || (cachedRow.synthesizedThrough == null && freshest != null)) {
        overdueMs = Number.POSITIVE_INFINITY;
      } else if (freshest != null && cachedRow.synthesizedThrough != null) {
        overdueMs = freshest - new Date(cachedRow.synthesizedThrough).getTime();
      }
    }
    return { story, contentHash: hash, tier, idx, overdueMs };
  });
  annotated
    .filter((a) => a.tier === 3 && a.overdueMs > 0)
    .sort((a, b) => b.overdueMs - a.overdueMs)
    .slice(0, STARVATION_PROMOTE_CAP)
    .forEach((a) => { a.tier = 1; });
  const orderedStories = annotated.sort((a, b) => a.tier - b.tier || a.idx - b.idx);

  for (const { story, contentHash } of orderedStories) {
    const isEditorProtected = story.synthMembers.some((m) => protectedKeys.has(m.key));
    // Key synthesis by the story's STABLE clusterId (Task #301), NOT a freshly
    // recomputed member-set hash. A churning story reclaims its prior id at
    // formation, so this keeps ONE synthesis row across source churn and lets the
    // read endpoints resolve it directly by the stored clusterId.
    const sig = story.signature;
    usedSignatures.push(sig);
    const cached = existing.get(sig);
    // Enrichment-aware re-synthesis (Task #207): a story can FORM before its
    // members are enriched (image/bullets/summary land asynchronously). Reusing on
    // membership alone would freeze a titles-only lede forever, so re-synthesize
    // once when the per-member CONTEXT-presence hash changes. (contentHash is
    // computed once in the ordering pass above and carried in, Task #1141.)
    const contentChanged = !cached || cached.contentHash !== contentHash;
    // Reuse only when membership is unchanged AND the cached row already carries
    // a synthesized headline. Rows cached before the headline field existed are
    // re-synthesized once so they pick up the short generalized headline.
    const hasContrast = story.synthMembers.some(
      (m) => m.cls === 'anchor-only' && m.label === 'contrast',
    );
    const cachedAlignments = (cached?.alignments as Record<string, { pct?: number }>) ?? {};
    // Re-synthesize ONCE to backfill a numeric alignment pct on contrast rows that
    // predate the AI alignment % (Task #253). Self-terminating: the synthesizer
    // ALWAYS stamps a pct on every entry it keeps, so a re-synthed row can never
    // satisfy this again.
    //
    // NOTE: there is deliberately NO "alignments == {} means missing" backfill
    // trigger. The column is NOT NULL DEFAULT '{}', so a genuinely-empty result
    // (the model found no divergence to itemize) is indistinguishable from a
    // never-synthesized row — forcing re-synthesis on {} would re-run every cycle
    // forever for any contrast story the model keeps returning empty for. A
    // stale/never-hashed row still re-synthesizes via contentChanged below, which
    // is the correct one-time backfill path.
    const pctMissing = hasContrast &&
      Object.values(cachedAlignments).some((a) => typeof a?.pct !== 'number');
    // Attributed-claims backfill (Task #256): the column is intentionally nullable
    // so rows synthesized before this field existed re-synthesize ONCE to pick up
    // their attributed claims. An empty array means "synthesized, none found" and
    // does NOT trigger re-synthesis; only a NULL (never-synthesized-for-claims) does.
    const attributedClaimsMissing = !!cached && cached.attributedClaims == null;
    // False-merge backstop backfill (Task #362): the column is nullable so a row
    // synthesized before this verdict existed re-synthesizes ONCE to pick one up.
    // Self-terminating — the synthesizer ALWAYS stamps a boolean.
    const corroboratedMissing = !!cached && cached.corroborated == null;
    // Long-lived-story SYNOPSIS refresh (Task #920). A clustered story that
    // legitimately outlives the 22h kinetic cap (48h developing-process lane /
    // 36h general active-extension) whose member SET has settled keeps a FROZEN
    // synopsis, because contentChanged only fires on a member-presence change. If
    // GENUINELY newer CONTRIBUTING content has landed since the synopsis was last
    // built (freshestContribMs leads the stored synthesized-through marker by a
    // meaningful margin), force a ONE-SHOT re-synthesis — bounded by a cooldown so
    // a fast-moving story refreshes once per development, never every pass.
    // Self-terminating: each synthesis stamps synthesizedThrough = freshestContribMs.
    const freshestContribMs = freshestContributingContentMs(story.synthMembers);
    const allPubMs = story.synthMembers
      .map((m) => (m.publishedAt ? new Date(m.publishedAt).getTime() : NaN))
      .filter((t) => Number.isFinite(t)) as number[];
    const nowMs = Date.now();
    const storyAgeH = allPubMs.length ? (nowMs - Math.min(...allPubMs)) / 3_600_000 : 0;
    const synthesizedThroughMs = cached?.synthesizedThrough
      ? new Date(cached.synthesizedThrough).getTime()
      : null;
    // One-time backfill: a cached row that predates the synthesized_through column
    // (null) re-synthesizes ONCE to stamp it, but only when we can actually
    // compute a freshest-contributing time (so the stamp is non-null and the
    // trigger self-terminates). Without this seed, a long-lived story whose
    // member set never changes would never acquire a marker and could never be
    // refreshed by the stale-synopsis rule below.
    const synthesizedThroughMissing =
      !!cached && cached.synthesizedThrough == null && freshestContribMs != null;
    const staleSynopsis =
      !!cached &&
      !!cached.headline &&
      shouldRefreshStaleSynopsis({
        ageH: storyAgeH,
        freshestContribMs,
        synthesizedThroughMs,
        msSinceLastSynthesis: cached.updatedAt
          ? nowMs - new Date(cached.updatedAt).getTime()
          : Number.POSITIVE_INFINITY,
        // Kinetic-dominant clusters (ongoing strikes / blockades / war ops) use
        // a shorter 1h cooldown so active war stories re-synthesize up to once
        // per hour rather than the default 2h. Pure title-vocabulary check —
        // same classifier as the phase-out and anchor-split gates.
        isKineticDominant: isKineticDominantCluster(story.synthMembers.map((m) => m.title)),
      });
    if (cached && cached.headline && cached.headline.trim() && !pctMissing && !attributedClaimsMissing && !corroboratedMissing && !synthesizedThroughMissing && !staleSynopsis && !contentChanged) {
      reused++;
      // Reused rows keep their stored verdict — a known false merge stays
      // dissolved every pass without a fresh LLM call. Editor-protected
      // stories are exempt from the dissolve action (Task #660).
      if (cached.corroborated === false && !isEditorProtected) dissolved.add(sig);
      continue;
    }
    // Headline continuity anchor: when this story already carries a valid cached
    // headline (re-synth triggered by content change, stale-synopsis refresh, or
    // a backfill column), pass it so the model KEEPS the wording unless the
    // dominant development materially changed (see buildSynthesisPrompt). A
    // signature flip (member churn) with no cached row synthesizes fresh — the
    // prune grace window in pruneCuratedStorySynthesisNotIn makes the flip-BACK
    // find its old row and reuse it wholesale instead. A NULL contentHash is a
    // DELIBERATE bust (bustCuratedStorySynthesisContentHash — e.g. the degraded
    // anchor-split path forcing a full re-roll of a pre-split synthesis), so the
    // stale headline must NOT anchor the replacement — suppress it.
    const priorHeadline =
      cached?.contentHash != null ? cached?.headline?.trim() || undefined : undefined;
    // Deadline check (Task #1088): don't LAUNCH a synthesis call that cannot
    // finish before the pass hard-timeout — the abort would kill it mid-flight
    // after the tokens were already spent. Deferred stories keep their cached
    // synthesis (sig already pushed to usedSignatures, so the prune below never
    // drops their rows); a prior false-merge verdict still stands.
    if (
      signal?.aborted ||
      attempted >= MAX_SYNTHESIS_CALLS_PER_PASS ||
      (deadlineAtMs != null && Date.now() + SYNTHESIS_STORY_BUDGET_MS > deadlineAtMs)
    ) {
      deferredCount++;
      if (cached?.corroborated === false && !isEditorProtected) dissolved.add(sig);
      continue;
    }
    attempted++;
    const storyController = new AbortController();
    const abortStory = () => storyController.abort();
    if (signal?.aborted) storyController.abort();
    else signal?.addEventListener('abort', abortStory, { once: true });
    const storyTimer = setTimeout(() => storyController.abort(), SYNTHESIS_STORY_BUDGET_MS);
    storyTimer.unref?.();
    let result: Awaited<ReturnType<typeof synthesizeStory>>;
    try {
      result = await synthesizeStory(story.synthMembers, storyController.signal, { priorHeadline });
    } finally {
      clearTimeout(storyTimer);
      signal?.removeEventListener('abort', abortStory);
    }
    if (result) {
      // Always persist a NON-EMPTY headline (fall back to the lede when the model
      // omitted one) so the reuse check above can't loop forever re-synthesizing a
      // row whose model output happened to lack a headline.
      const headline = result.headline.trim() || result.lede;
      // Continuity-churn telemetry (Task #1100): this re-synthesis carried a
      // prior headline as its continuity anchor — record whether the persisted
      // headline actually changed. Log-only; never alters what is persisted.
      if (priorHeadline) recordCuratedSynthResynth(headline !== priorHeadline);
      await storage.upsertCuratedStorySynthesis({
        signature: sig,
        headline,
        lede: result.lede,
        facts: result.facts,
        spins: result.spins,
        alignments: result.alignments,
        attributedClaims: result.attributedClaims,
        contentHash,
        corroborated: result.corroborated,
        // Stamp the freshest CONTRIBUTING content this synopsis was built from
        // (Task #920). Always non-null when computable so the stale-synopsis
        // trigger self-terminates; falls back to any prior marker (or null) when
        // no contributing member carries a usable date.
        synthesizedThrough:
          freshestContribMs != null
            ? new Date(freshestContribMs)
            : (cached?.synthesizedThrough ?? null),
      });
      synthesized++;
      if (result.corroborated === false && !isEditorProtected) dissolved.add(sig);
    } else if (cached && cached.corroborated === false && !isEditorProtected) {
      // Synthesis failed this pass but a prior false-merge verdict stands — keep
      // dissolving so a transient LLM hiccup can't resurrect a bogus merged card.
      dissolved.add(sig);
    }
  }

  await storage.pruneCuratedStorySynthesisNotIn(usedSignatures);
  console.log(
    `[CuratedCluster] Synthesis — ${synthesized} new, ${reused} reused, ${usedSignatures.length} total stories${deferredCount ? `, ${deferredCount} deferred (pass deadline)` : ''}${dissolved.size ? `, ${dissolved.size} likely false-merge` : ''}`,
  );
  return dissolved;
}

// ---------------------------------------------------------------------------
// ANCHOR-AWARE EVENT-IDENTITY BACKSTOP (attach-vs-spawn).
// ---------------------------------------------------------------------------
// Phase 1 (curatedSynthesis.buildSynthesisPrompt) makes each formed story's
// neutral headline + corroborated facts anchor on the cluster's DOMINANT
// development. This is the lean Phase 2 safety net: AFTER synthesis, audit
// whether any member's OVERARCHING TOPIC is a genuinely DIFFERENT event from
// that established anchor and, if so, RELEASE it back to a stand-alone card so
// the NEXT pass's grouping re-clusters it with its true peers. There is NO
// in-pass re-formation — releasing mirrors the existing dissolved-cluster
// release path exactly. Strictly conservative + fail-open:
//   - a multi-day DEVELOPING PROCESS (one negotiation/deal) stays ONE story;
//   - adversary / opinion SPIN of the SAME event stays ATTACHED as contrast;
//   - the backstop can NEVER dissolve a cluster — any release that would drop
//     the kept set below the formation gate is VETOED (cluster left untouched);
//   - any LLM/parse failure leaves the cluster exactly as synthesis formed it.
// Curated-lane only — operates on formed curated stories, never shared feeds.
// ---------------------------------------------------------------------------
const ANCHOR_SPLIT_ENABLED = true;
// Bound the per-pass cost: only the N largest formed stories are audited (a
// foreign event is far likelier to hide inside a big cluster, and a 2-member
// cluster can never be split — see the gate veto below).
const ANCHOR_SPLIT_MAX_CLUSTERS = 15;
const ANCHOR_SPLIT_MIN_MEMBERS = 3;
// Hard ceiling on how many members ONE cluster may release in a single pass.
// A huge cluster can therefore never be shattered in one move; releasing fewer
// only LEAVES MORE in the kept set, which keeps the (already-passed) formation
// gate safe — so clamping can never strand a story. Bounds archive churn too.
const ANCHOR_SPLIT_MAX_RELEASES_PER_CLUSTER = 3;
// Oversized-cluster escape hatch (megacluster over-merge fix). On a multi-crisis
// day the "developing-process" label (summit/talks/deal/ceasefire) trivially
// clears on dozens of UNRELATED titles, and the deterministic developing-process
// HARD-SKIP below then leaves a 100+ member megacluster fully intact. When a
// formed story crosses these thresholds we treat it as no-longer-one-story: the
// hard-skip is LIFTED (the LLM event-identity classifier audits it) and its
// release cap is raised so the classifier can actually carve the unrelated events
// out. Normal-size process stories (8-25 members) never cross these bars and stay
// fully protected. Deterministic gating (we cannot A/B live). Set
// CURATED_OVERSIZED_ESCAPE_DISABLED to revert to the legacy always-skip behavior.
const CURATED_OVERSIZED_ESCAPE_ENABLED =
  !/^(1|true|yes|on)$/i.test(process.env.CURATED_OVERSIZED_ESCAPE_DISABLED ?? '');
// Absolute member count above which a process cluster is "oversized" regardless of
// the rest of the lane; OR (>= FRAC_SIZE members AND >= FRAC of ALL clustered
// members this pass) so a page-dominant cluster on a light-news day also qualifies.
const ANCHOR_SPLIT_OVERSIZED_ABS = 60;
const ANCHOR_SPLIT_OVERSIZED_FRAC_SIZE = 40;
const ANCHOR_SPLIT_OVERSIZED_FRAC = 0.3;
// Raised per-cluster release cap for oversized clusters ONLY (normal clusters keep
// the tiny cap above). Big enough to meaningfully shrink a 135-member card in one
// pass; the formation-gate veto in applyAnchorEventSplitDecisions still prevents
// dissolving a story below its corroboration floor, so this can never strand one.
const ANCHOR_SPLIT_OVERSIZED_MAX_RELEASES = 40;

export type AnchorEventDecision =
  | 'same_event_attach'
  | 'same_event_contrast'
  | 'different_event_split'
  | 'uncertain_keep';

export interface AnchorSplitMemberInput {
  key: string;
  cls: 'corroborating' | 'anchor-only' | 'attach';
  publisherKey: string;
  decision: AnchorEventDecision;
}

export interface AnchorSplitResult {
  // Member keys to RELEASE to stand-alone (only when the kept set still forms).
  releasedKeys: string[];
  // True when a release was applied; false when nothing split OR a split was vetoed.
  changed: boolean;
  // True when a proposed split was VETOED to protect the formation gate.
  vetoed: boolean;
}

// PURE decision core (no LLM / DB) — exported for regression testing. Given each
// member's behavior class, publisher key, and per-member event-identity decision,
// release ONLY the members judged a genuinely DIFFERENT event, and ONLY when the
// surviving cluster STILL satisfies the formation gate (>= MIN_CONTRIBUTING_TO_FORM
// corroborating members across >= MIN_CONTRIBUTING_TO_FORM distinct publishers).
// Otherwise veto entirely so the backstop can never dissolve a real story or
// strand it below the gate — that is the (existing) false-merge path's job, never
// this one's.
export function applyAnchorEventSplitDecisions(
  members: AnchorSplitMemberInput[],
): AnchorSplitResult {
  const splitKeys = members
    .filter((m) => m.decision === 'different_event_split')
    .map((m) => m.key);
  if (splitKeys.length === 0) return { releasedKeys: [], changed: false, vetoed: false };

  const splitSet = new Set(splitKeys);
  const kept = members.filter((m) => !splitSet.has(m.key));
  const keptCorroborating = kept.filter((m) => m.cls === 'corroborating');
  const distinctPublishers = new Set(
    keptCorroborating.map((m) => m.publisherKey.trim().toLowerCase()).filter(Boolean),
  );

  if (
    keptCorroborating.length >= MIN_CONTRIBUTING_TO_FORM &&
    distinctPublishers.size >= MIN_CONTRIBUTING_TO_FORM
  ) {
    return { releasedKeys: splitKeys, changed: true, vetoed: false };
  }
  return { releasedKeys: [], changed: false, vetoed: true };
}

export interface AnchorSplitCommit {
  // Keys to ACTUALLY release this pass — empty unless the shrunken story was
  // re-synthesized AND persisted, so a member is never dropped while a stale
  // synthesis still describes the larger (pre-split) cluster.
  commitReleased: string[];
  // Story signature to ADD to the dissolved set (shrinking revealed a false
  // merge), or null.
  dissolvedAdd: string | null;
  // Story signature to REMOVE from the dissolved set (shrinking repaired a
  // false merge), or null.
  dissolvedRemove: string | null;
}

// PURE commit-gating core (no LLM / DB) — exported for regression testing. Decide
// what the anchor-split backstop may COMMIT for one shrunken story, given whether
// the re-synthesis+persist of the kept set actually succeeded. FAIL-OPEN: if the
// shrunken story could not be re-synthesized/persisted (resynthPersisted false),
// release NOTHING and touch no dissolved verdict — the member stays in its
// original cluster, which keeps its still-valid pre-split synthesis. Only once the
// kept set has a fresh persisted anchor do we (a) commit the releases and (b)
// re-apply the EXISTING false-merge corroboration verdict to the shrunken set
// (corroborated===false -> dissolve; else un-dissolve). The release math itself
// can never dissolve a cluster (see applyAnchorEventSplitDecisions' veto); the
// dissolved flip here only defers to the pre-existing corroboration quality gate
// on the freshly re-synthesized content.
//
// OVERSIZED EXCEPTION (mega-cluster resilience): for an OVERSIZED "dumping-ground"
// cluster, the strict fail-open above lets a mega-cluster keep absorbing genuinely
// different events forever whenever synthesis is unavailable (e.g. an AI-provider
// stall) — the classifier flags the unrelated members every pass but the release
// can never commit. That is the opposite of fail-safe for the reader. So when
// `oversized` is true we STILL commit the classifier-approved releases even if
// re-synthesis was unavailable: the huge kept set trivially satisfies the
// formation gate, and the stale synthesis (built over a slightly larger set) is
// negligibly different and self-heals next pass (its contentHash no longer matches
// the shrunken member set → forced re-synthesis). We DO NOT flip the dissolved
// verdict in this degraded path because we have no fresh corroboration read.
export function resolveAnchorSplitCommit(opts: {
  releasedKeys: string[];
  resynthPersisted: boolean;
  corroborated: boolean | null;
  signature: string;
  oversized?: boolean;
}): AnchorSplitCommit {
  if (opts.releasedKeys.length === 0) {
    return { commitReleased: [], dissolvedAdd: null, dissolvedRemove: null };
  }
  if (!opts.resynthPersisted) {
    // Normal-size clusters keep the strict fail-open (release nothing). Oversized
    // clusters release anyway to escape the mega-cluster trap, but never touch the
    // dissolved verdict without a fresh corroboration assessment.
    if (opts.oversized) {
      return { commitReleased: opts.releasedKeys, dissolvedAdd: null, dissolvedRemove: null };
    }
    return { commitReleased: [], dissolvedAdd: null, dissolvedRemove: null };
  }
  return {
    commitReleased: opts.releasedKeys,
    dissolvedAdd: opts.corroborated === false ? opts.signature : null,
    dissolvedRemove: opts.corroborated === false ? null : opts.signature,
  };
}

// Distinct-publisher key for a synthesis member — mirrors the formation-gate
// publisherKey (hostname, www-stripped + lowercased; fall back to source name,
// then the node key) so the kept-set veto above counts publishers exactly as
// formation did.
function synthPublisherKey(m: SynthMember): string {
  if (m.url) {
    try {
      return new URL(m.url).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      /* fall through */
    }
  }
  const s = (m.source ?? '').trim().toLowerCase();
  return s || `key:${m.key}`;
}

// ---------------------------------------------------------------------------
// SAME-EVENT DUPLICATE RECONCILIATION (Task #1085 — one-merge-per-pass).
// ---------------------------------------------------------------------------
// Fail-closed, precision-first backstop for the MISSED-merge symptom: two
// SIBLING formed stories that actually describe the SAME event but were formed
// as two separate Top-Story cards (the clustering LLM split them). This is the
// mirror of the anchor-split backstop (which handles OVER-merge). It merges AT
// MOST ONE pair per pass so it can never build a runaway megacluster, and it
// only acts on genuinely high-confidence duplicates — otherwise it is a no-op.
//
// A candidate PAIR (A, B) qualifies only when ALL hold:
//   * each of A and B already passed the formation gate on its own — i.e. each
//     has >= MIN_CONTRIBUTING_TO_FORM CORROBORATING members from
//     >= MIN_CONTRIBUTING_TO_FORM DISTINCT publishers (never fuse a weak/attach
//     cluster into a strong one);
//   * neither is a re-partition SPLIT CHILD (excludeSignatures) — we must never
//     fight the anchor-split / smart-repartition systems by re-merging what they
//     deliberately separated;
//   * the combined member count stays <= MISSED_MERGE_RECONCILE_MAX_COMBINED
//     (bounded — keeps max_cluster_size in check);
//   * a corroborating member of A and one of B are the SAME event: their titles
//     are titlesHighlySimilar AND they fall withinSameEventWindow (time-gated so
//     a same-worded next-cycle event is never fused).
//
// Selection is fully DETERMINISTIC (no randomness, stable across identical
// input) so the same duplicate always reconciles the same way: strongest
// evidence first (highest shared-title-token peak), tie-broken by smallest
// combined size, then lexicographic signature pair. The larger story WINS
// (keeps its clusterId + representative for identity continuity); the smaller is
// merged into it. Exported pure for regression testing.
// ---------------------------------------------------------------------------
export const MISSED_MERGE_RECONCILE_MAX_COMBINED = 40;

export interface ReconcileFormedStory {
  signature: string;
  synthMembers: Array<Pick<SynthMember, 'key' | 'url' | 'source' | 'title' | 'cls' | 'publishedAt'>>;
}

export interface MissedMergeReconciliation {
  winnerSignature: string;
  loserSignature: string;
  sharedTokenPeak: number;
}

function reconcilePublisherKey(
  m: Pick<SynthMember, 'key' | 'url' | 'source'>,
): string {
  if (m.url) {
    try {
      return new URL(m.url).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      /* fall through */
    }
  }
  const s = (m.source ?? '').trim().toLowerCase();
  return s || `key:${m.key}`;
}

export function chooseMissedMergeReconciliation(
  formedStories: ReconcileFormedStory[],
  excludeSignatures?: Set<string>,
): MissedMergeReconciliation | null {
  // Only formation-strong, non-excluded stories are eligible.
  const prepared = formedStories
    .filter((s) => !excludeSignatures?.has(s.signature))
    .map((s) => {
      const corr = s.synthMembers.filter((m) => m.cls === 'corroborating');
      const pubs = new Set(corr.map(reconcilePublisherKey));
      return {
        signature: s.signature,
        size: s.synthMembers.length,
        pubs,
        corr: corr.map((m) => ({
          tokens: significantTitleTokens(m.title),
          publishedAt: m.publishedAt ?? null,
        })),
      };
    })
    .filter((p) => p.pubs.size >= MIN_CONTRIBUTING_TO_FORM);

  if (prepared.length < 2) return null;

  let best: MissedMergeReconciliation | null = null;
  let bestPeak = 0;
  let bestCombined = Infinity;

  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const A = prepared[i];
      const B = prepared[j];
      const combined = A.size + B.size;
      if (combined > MISSED_MERGE_RECONCILE_MAX_COMBINED) continue;

      // Strongest same-event evidence across every cross pair of corroborating
      // members (shared significant-title-token count over the smaller set).
      let peak = 0;
      for (const a of A.corr) {
        for (const b of B.corr) {
          if (!withinSameEventWindow(a.publishedAt, b.publishedAt)) continue;
          if (!titlesHighlySimilar(a.tokens, b.tokens)) continue;
          const [small, large] =
            a.tokens.size <= b.tokens.size ? [a.tokens, b.tokens] : [b.tokens, a.tokens];
          let shared = 0;
          small.forEach((t) => {
            if (large.has(t)) shared++;
          });
          if (shared > peak) peak = shared;
        }
      }
      if (peak === 0) continue;

      // Larger story wins (identity continuity); deterministic tie-breaks.
      const winnerSig =
        A.size !== B.size
          ? A.size > B.size
            ? A.signature
            : B.signature
          : A.signature < B.signature
            ? A.signature
            : B.signature;
      const loserSig = winnerSig === A.signature ? B.signature : A.signature;

      const isBetter =
        peak > bestPeak ||
        (peak === bestPeak && combined < bestCombined) ||
        (peak === bestPeak &&
          combined === bestCombined &&
          best !== null &&
          `${winnerSig}|${loserSig}` < `${best.winnerSignature}|${best.loserSignature}`);

      if (isBetter || best === null) {
        best = { winnerSignature: winnerSig, loserSignature: loserSig, sharedTokenPeak: peak };
        bestPeak = peak;
        bestCombined = combined;
      }
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// DISJOINT-ACTOR HINT for the oversized-cluster anchor-split (megacluster
// over-merge, levers B+C). On a multi-crisis day a US–Iran "Military Ops"
// megacluster can silently absorb genuinely UNRELATED events (a Taiwan chip-fab
// deal, Black-Sea tanker attacks, Russia drone strikes) whose titles merely
// share surface vocabulary ("strike", "deal", "$100 billion") with the anchor —
// so the LLM event-identity classifier, biased toward same_event, releases ~0.
// These helpers give the classifier a DETERMINISTIC nudge: extract each title's
// named geopolitical actors from a controlled vocabulary, compute the cluster's
// DOMINANT actor core, and TAG any member whose actors are ALL outside that core
// as a strong different_event_split candidate. The LLM stays the sole decider —
// the tag only counters its same_event bias. Precision-first + fail toward keep:
// a member with NO recognized actor, or ANY actor overlapping the core, is never
// tagged, so a missed match can only WITHHOLD a nudge, never force a split.
// Curated-lane only; pure + exported for regression testing.
// ---------------------------------------------------------------------------
// Controlled geopolitical-actor vocabulary. Maps each canonical actor token to
// the alias patterns that name it in a headline. Intentionally conservative:
// under-matching only withholds a hint (safe), so the list need not be
// exhaustive. Bare "us" is included despite the pronoun/"Washington"/"America"
// collision. In a US-dominant core (the common case, incl. the US–Iran bug this
// fixes) a false "us" match OVERLAPS the core → NOT tagged → can only prevent a
// split. RESIDUAL RISK: in a NON-US-core oversized cluster (e.g. Russia–Ukraine)
// a member matching ONLY a false "us" would be tagged and nudged toward split —
// but that is still bounded by oversized-only + LLM-is-sole-decider + the
// formation-gate veto + the release cap, so worst case is a nudge the LLM
// ignores. If the flight recorder shows DIFFERENT-CORE-ACTORS tags carrying "us"
// in non-US cores, make the bare 2-letter form case-sensitive ("US" not "us").
const ANCHOR_ACTOR_VOCAB: Array<[string, RegExp]> = [
  ['us', /\b(u\.?s\.?a?|us|united states|america|american|washington|pentagon)\b/i],
  ['iran', /\b(iran|iranian|tehran|irgc|khamenei|ayatollah)\b/i],
  ['israel', /\b(israel|israeli|idf|netanyahu|jerusalem)\b/i],
  ['russia', /\b(russia|russian|moscow|putin|kremlin)\b/i],
  ['ukraine', /\b(ukraine|ukrainian|kyiv|kiev|zelensky|zelenskyy)\b/i],
  ['china', /\b(china|chinese|beijing|prc)\b/i],
  ['taiwan', /\b(taiwan|taiwanese|taipei|tsmc)\b/i],
  ['north korea', /\b(north korea|north korean|pyongyang|kim jong)\b/i],
  ['south korea', /\b(south korea|south korean|seoul)\b/i],
  ['gaza', /\b(gaza|hamas|palestinian|palestine)\b/i],
  ['hezbollah', /\b(hezbollah|hizbollah|lebanon|lebanese|beirut)\b/i],
  ['yemen', /\b(yemen|yemeni|houthi|houthis)\b/i],
  ['syria', /\b(syria|syrian|damascus)\b/i],
  ['india', /\b(india|indian|modi)\b/i],
  ['pakistan', /\b(pakistan|pakistani|islamabad)\b/i],
  ['venezuela', /\b(venezuela|venezuelan|caracas|maduro)\b/i],
  ['nato', /\bnato\b/i],
  ['japan', /\b(japan|japanese|tokyo)\b/i],
  ['saudi arabia', /\b(saudi|riyadh)\b/i],
  ['turkey', /\b(turkey|turkish|ankara|erdogan)\b/i],
  ['egypt', /\b(egypt|egyptian|cairo)\b/i],
  ['qatar', /\b(qatar|doha)\b/i],
];

// PURE — extract the set of canonical geopolitical actors named in a title.
export function extractActorTokens(title: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!title) return out;
  for (const [canon, re] of ANCHOR_ACTOR_VOCAB) {
    if (re.test(title)) out.add(canon);
  }
  return out;
}

// PURE — the cluster's DOMINANT actor core: actors named in at least a modest
// fraction of members (floor of 2 so a small cluster still needs corroboration).
// Kept low (10%) so a genuine secondary actor of the SAME story — a mediator, a
// regional ally — still counts as core and its members are never tagged.
export function computeDominantActors(memberTitles: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const title of memberTitles) {
    for (const a of extractActorTokens(title)) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(memberTitles.length * 0.1));
  const dominant = new Set<string>();
  for (const [a, c] of counts) if (c >= threshold) dominant.add(a);
  return dominant;
}

// PURE — TRUE when this member names actors that are ALL outside the dominant
// core (a strong "different event that merely shares keywords/region" signal).
// Members with no recognized actor, or any actor overlapping the core, are never
// tagged (fail toward keep — the LLM decides).
export function memberHasDisjointActors(title: string, dominant: Set<string>): boolean {
  if (dominant.size === 0) return false;
  const actors = extractActorTokens(title);
  if (actors.size === 0) return false;
  for (const a of actors) if (dominant.has(a)) return false;
  return true;
}

// PURE — assemble the numbered MEMBERS block for the classifier prompt. For an
// OVERSIZED cluster it also tags members whose actors are disjoint from the
// cluster's dominant core. Exported so the gate can verify the tag fires on a
// genuinely-foreign member and stays OFF for same-core members and for
// normal-size clusters. Returns the dominant core and hint count for the prompt
// override + flight-recorder logging.
export function buildAnchorClassifierMemberLines(
  members: Array<Pick<SynthMember, 'title' | 'source' | 'cls' | 'label'>>,
  oversized: boolean,
): { list: string; dominant: string[]; hintedCount: number } {
  const dominant = oversized
    ? computeDominantActors(members.map((m) => m.title))
    : new Set<string>();
  let hintedCount = 0;
  const list = members
    .map((m, idx) => {
      const role =
        m.cls === 'corroborating'
          ? 'corroborating'
          : m.cls === 'anchor-only' && m.label === 'primary'
            ? 'primary/origin'
            : 'contrast';
      let line = `${idx + 1}. [${role}] "${m.title}" (${m.source})`;
      if (oversized && memberHasDisjointActors(m.title, dominant)) {
        hintedCount++;
        line += ` [DIFFERENT CORE ACTORS: ${[...extractActorTokens(m.title)].join(', ')}]`;
      }
      return line;
    })
    .join('\n');
  return { list, dominant: [...dominant], hintedCount };
}

// Classify each member of a formed story against its synthesized anchor. Uses the
// 1-based INDEX-addressed contract (mirrors identifyCuratedClusters) so the model
// echoes small integers it can't mis-transcribe. Returns a key->decision map, or
// null on any LLM/parse failure (caller fails open — keeps the cluster intact).
async function classifyAnchorEventMembers(
  members: SynthMember[],
  synth: { headline?: string | null; facts?: string[] | null; attributedClaims?: string[] | null },
  // Set when the developing-process hard-skip was LIFTED for a pathologically-large
  // cluster: appends an override note to counter the base "prefer same_event" bias,
  // and (with the scaled max_tokens below) keeps the JSON from truncating at scale.
  oversized = false,
  signal?: AbortSignal,
): Promise<Map<string, AnchorEventDecision> | null> {
  // Build the numbered MEMBERS block; for an oversized cluster this also tags any
  // member whose named actors are ALL outside the cluster's dominant actor core
  // (a deterministic different-event nudge — the LLM stays the sole decider).
  const { list, dominant, hintedCount } = buildAnchorClassifierMemberLines(members, oversized);
  const factsBlock = (synth.facts ?? []).filter(Boolean).map((f) => `- ${f}`).join('\n') || '(none)';
  const claimsBlock =
    (synth.attributedClaims ?? []).filter(Boolean).map((c) => `- ${c}`).join('\n') || '(none)';

  const prompt = `You are an intelligence editor auditing a formed news cluster. The cluster already has an established ANCHOR — a neutral headline plus the facts corroborated across its independent sources. Decide, for EACH member, whether it covers the SAME OVERARCHING EVENT/STORY as that anchor.

CLUSTER ANCHOR
Headline: ${synth.headline ?? '(none)'}
Corroborated facts:
${factsBlock}
Attributed claims (context only):
${claimsBlock}

MEMBERS (each is one source's coverage):
${list}

For EACH member return ONE label:
- "same_event_attach": covers the SAME overarching event/story as the anchor — even a different angle, update, demand, condition, consequence, mediator, reaction, or sub-development of the SAME event or developing process. This is the DEFAULT for anything plausibly part of the same story.
- "same_event_contrast": covers the SAME overarching event but from an adversary / state-media / opinion / spin angle. KEEP it — contrast belongs in this cluster.
- "different_event_split": covers a GENUINELY DIFFERENT event — a separate incident with DIFFERENT actors, place, or subject that merely shares keywords, a region, or a broad theme with the anchor. Use ONLY when you are confident it is a different story, NOT merely a different facet of the same one.
- "uncertain_keep": you cannot tell — keep it.

CRITICAL RULES:
- A multi-day DEVELOPING PROCESS — the SAME negotiation, deal, agreement, ceasefire, summit, or its terms/demands/conditions/mediators/violations/signing mechanics — is ONE story. Sanctions relief, inspector access, prisoner/asset releases, threats and warnings that all belong to the SAME deal are same_event, NEVER different_event_split.
- Adversary or alarmist SPIN of the same event is same_event_contrast, NEVER different_event_split.
- A different broad theme is NOT a different event by itself ("diplomacy", "the war", "the economy" are themes, not events). Split ONLY on a concretely different incident/actors/subject.
- LEGISLATIVE / APPROPRIATIONS / BUDGET PROCESS vs. KINETIC OPERATIONS: if the cluster anchor is about KINETIC MILITARY OPERATIONS (strikes, attacks, interceptions, air operations, casualties), a member that is about the LEGISLATIVE, APPROPRIATIONS, OR BUDGET PROCESS for that conflict (Congressional spending packages, NDAA / defense authorization fights, supplemental funding requests, budget resolutions, floor votes about war funding) is a DIFFERENT EVENT — use different_event_split. Such items name the same war but cover Washington's funding debate, not the military operations. Exception: a specific official reaction to the kinetic strikes (condemnation, threat, casualty announcement) still belongs — only pure funding / appropriations / authorization-vote stories split.
- Strongly PREFER same_event_attach / same_event_contrast / uncertain_keep. Reserve different_event_split for clear, confident cases. When in doubt, do NOT split.
${oversized ? `
OVERRIDE FOR THIS CLUSTER: This cluster is ABNORMALLY LARGE and is suspected to have absorbed MULTIPLE UNRELATED events (e.g. a summit, a separate strike, and an unrelated trade deal fused together by a shared keyword or region). For THIS cluster, apply "different_event_split" confidently for any member whose core actors, place, or subject genuinely differ from the anchor — do NOT let the "prefer same_event" bias keep an unrelated event attached. Still KEEP genuine same-event angles, updates, reactions, demands, and adversary/contrast spin of the anchor's own event.${
  dominant.length > 0 && hintedCount > 0
    ? `
ACTOR SIGNAL: The cluster's DOMINANT actor core is: ${dominant.join(', ')}. Members tagged "[DIFFERENT CORE ACTORS: ...]" name only actors OUTSIDE that core, so they are STRONG different_event_split candidates — split them unless the anchor's corroborated facts clearly show they are the SAME event. Untagged members are unaffected by this signal; judge them on the rules above.`
    : ''
}
` : ''}
Return ONLY a JSON object: {"decisions":[{"i":1,"label":"same_event_attach"},{"i":2,"label":"different_event_split"}]}`;

  const response = await createCuratedClusterCompletion({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    // Scale with member count so a large oversized-escape cluster (100+ members ->
    // 100+ decisions) never TRUNCATES the JSON (which would parse to null and make
    // the escape hatch silently no-op). Floor at the historical 1500, cap at 4000.
    max_tokens: Math.min(4000, Math.max(1500, 500 + members.length * 20)),
    response_format: { type: 'json_object' },
  }, signal);
  const content = response.choices[0]?.message?.content?.trim();
  if (!content) return null;
  const parsed = parseJsonObjectLoose(content);
  if (parsed === null) return null;
  const rawDecisions = (parsed as { decisions?: unknown })?.decisions;
  if (!Array.isArray(rawDecisions)) return null;

  const VALID: AnchorEventDecision[] = [
    'same_event_attach',
    'same_event_contrast',
    'different_event_split',
    'uncertain_keep',
  ];
  const out = new Map<string, AnchorEventDecision>();
  for (const d of rawDecisions as Array<{ i?: unknown; label?: unknown }>) {
    const idx = typeof d.i === 'number' ? d.i : Number(d.i);
    if (!Number.isInteger(idx) || idx < 1 || idx > members.length) continue;
    const label = typeof d.label === 'string' ? d.label : '';
    if (!VALID.includes(label as AnchorEventDecision)) continue;
    out.set(members[idx - 1].key, label as AnchorEventDecision);
  }
  return out;
}

// Orchestrate the anchor-aware split over the formed stories. Audits only the
// largest formed clusters that already carry a synthesized anchor (headline +
// >= 1 fact), capped per pass. For each cluster it shrinks, re-synthesizes the
// kept members under the SAME signature (so the anchor reflects the survivors)
// and refreshes the dissolved verdict. Fail-open + curated-lane only; never throws.
async function anchorAwareSplitFormedStories(
  formedStories: Array<{ signature: string; synthMembers: SynthMember[] }>,
  // Keys of nodes belonging to an ACTIVE editor manual-link (Task #660).
  // Hard-pinned below to `same_event_attach` so this backstop can never
  // release a member the editor deliberately merged/linked in, regardless of
  // what the AI event-identity classifier decided for it.
  protectedKeys: Set<string> = new Set(),
  signal?: AbortSignal,
): Promise<{
  releasedKeys: Set<string>;
  dissolvedAdds: Set<string>;
  dissolvedRemoves: Set<string>;
  // Flight-recorder counters (see curated_cluster_metrics). audited = clusters
  // that actually reached the LLM event-identity classifier; the rest are
  // explainers for why a candidate did NOT release members.
  audited: number;
  developingProcessSkips: number;
  vetoes: number;
  releaseCapClamps: number;
  oversizedEscapes: number;
  oversizedReleased: number;
  releasedCount: number;
}> {
  const releasedKeys = new Set<string>();
  const dissolvedAdds = new Set<string>();
  const dissolvedRemoves = new Set<string>();
  // Signatures whose members we released in the DEGRADED oversized path (release
  // committed WITHOUT a fresh re-synthesis). We bust their stored synthesis
  // contentHash after the loop so the next pass is GUARANTEED to re-synthesize the
  // shrunken kept set even if regrouping re-absorbs the same members (synthesis
  // runs before anchor-split, so a matching contentHash would otherwise reuse the
  // stale synthesis indefinitely during an AI stall).
  const degradedResynthSigs = new Set<string>();
  let audited = 0;
  let developingProcessSkips = 0;
  let vetoes = 0;
  let releaseCapClamps = 0;
  let oversizedEscapes = 0;
  let oversizedReleased = 0;
  const result = () => ({
    releasedKeys,
    dissolvedAdds,
    dissolvedRemoves,
    audited,
    developingProcessSkips,
    vetoes,
    releaseCapClamps,
    oversizedEscapes,
    oversizedReleased,
    releasedCount: releasedKeys.size,
  });
  if (!ANCHOR_SPLIT_ENABLED || !isAIConfigured()) {
    return result();
  }

  let synthMap: Awaited<ReturnType<typeof storage.getCuratedStorySynthesisMap>>;
  try {
    synthMap = await storage.getCuratedStorySynthesisMap();
  } catch (err) {
    console.warn(
      '[CuratedCluster] Anchor-split: synthesis map load failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
    return result();
  }

  const candidates = formedStories
    .filter((s) => s.synthMembers.length >= ANCHOR_SPLIT_MIN_MEMBERS)
    .map((s) => ({ story: s, synth: synthMap.get(s.signature) }))
    .filter(
      (c) =>
        !!c.synth &&
        !!c.synth.headline &&
        c.synth.headline.trim().length > 0 &&
        Array.isArray(c.synth.facts) &&
        c.synth.facts.length > 0,
    )
    .sort((a, b) => b.story.synthMembers.length - a.story.synthMembers.length)
    .slice(0, ANCHOR_SPLIT_MAX_CLUSTERS);

  // Total clustered members this pass — the denominator for the oversized
  // "dominance" test (a cluster that is a large FRACTION of everything clustered
  // is oversized even at a moderate absolute count on a light-news day).
  const totalClusteredMembers = formedStories.reduce(
    (n, s) => n + s.synthMembers.length,
    0,
  );

  for (const { story, synth } of candidates) {
    try {
      const size = story.synthMembers.length;
      // Oversized escape hatch (megacluster over-merge fix). A pathologically-large
      // cluster is no longer one story even if it reads as a developing process, so
      // we LIFT the developing-process hard-skip for it and let the LLM classifier
      // carve out the unrelated events. Normal-size process stories never cross
      // these bars and remain fully protected by the hard skip below.
      const oversized =
        CURATED_OVERSIZED_ESCAPE_ENABLED &&
        (size >= ANCHOR_SPLIT_OVERSIZED_ABS ||
          (size >= ANCHOR_SPLIT_OVERSIZED_FRAC_SIZE &&
            totalClusteredMembers > 0 &&
            size / totalClusteredMembers >= ANCHOR_SPLIT_OVERSIZED_FRAC));

      // Deterministic developing-process veto (HARD SKIP). A multi-day
      // negotiation / deal / ceasefire / talks process is ONE story by spec — its
      // phases legitimately span many outlets and angles, so it is the exact thing
      // the anchor-split must never fragment. We skip it BEFORE the LLM classifier
      // even runs. A false positive merely leaves a possible stray attached; a
      // false negative could shatter the protected process story — so this is a
      // hard skip, not a softened bar. EXCEPTION: an oversized cluster (above) has
      // outgrown the "one story" assumption, so the skip is lifted for it.
      const isProcess = isDevelopingProcessCluster(story.synthMembers.map((m) => m.title));
      if (isProcess && !oversized) {
        developingProcessSkips++;
        console.log(
          `[CuratedCluster] Anchor-split: developing-process cluster ${story.signature} skipped (left intact)`,
        );
        continue;
      }
      // Meter EVERY oversized audit — decoupled from the isProcess label (Task
      // megacluster-hardening). Previously oversizedEscapes only counted the
      // process clusters whose hard-skip was lifted, so an oversized NON-process
      // cluster (which still gets the raised release cap + actor-hint prompt) was
      // invisible in the flight recorder. Both now get the oversized treatment and
      // both are counted, so curated_cluster_metrics reflects the real audit load.
      if (oversized) {
        oversizedEscapes++;
        console.log(
          isProcess
            ? `[CuratedCluster] Anchor-split: OVERSIZED developing-process cluster ${story.signature} (${size} members / ${totalClusteredMembers} clustered) — hard-skip LIFTED, auditing for unrelated events`
            : `[CuratedCluster] Anchor-split: OVERSIZED cluster ${story.signature} (${size} members / ${totalClusteredMembers} clustered) — auditing for unrelated events (raised release cap + actor hints)`,
        );
      }

      audited++;
      const decisions = await classifyAnchorEventMembers(story.synthMembers, synth!, oversized, signal);
      if (!decisions) continue; // fail-open: keep the cluster intact

      const inputs: AnchorSplitMemberInput[] = story.synthMembers.map((m) => ({
        key: m.key,
        cls: m.cls,
        publisherKey: synthPublisherKey(m),
        // Editor-forced members are HARD-PINNED same_event_attach (Task #660)
        // — never released, regardless of the AI classifier's raw verdict.
        decision: protectedKeys.has(m.key)
          ? 'same_event_attach'
          : decisions.get(m.key) ?? 'uncertain_keep',
      }));
      const { releasedKeys: rawRel, changed, vetoed } = applyAnchorEventSplitDecisions(inputs);
      if (vetoed) {
        vetoes++;
        console.log(
          `[CuratedCluster] Anchor-split VETOED for story ${story.signature} — release would drop it below the formation gate; left intact`,
        );
      }
      if (!changed || rawRel.length === 0) continue;

      // Per-cluster release cap. Clamp to the first N release keys so one cluster
      // can never be shattered in a single pass. Clamping releases FEWER members,
      // leaving a LARGER kept set — which only makes the already-satisfied
      // formation gate safer, never strands a story. Deterministic (stable order).
      let rel = rawRel;
      // Oversized clusters get the raised cap so the classifier can meaningfully
      // shrink a 135-member card in one pass; normal clusters keep the tiny cap.
      const releaseCap = oversized
        ? ANCHOR_SPLIT_OVERSIZED_MAX_RELEASES
        : ANCHOR_SPLIT_MAX_RELEASES_PER_CLUSTER;
      if (rel.length > releaseCap) {
        rel = rel.slice(0, releaseCap);
        releaseCapClamps++;
        console.log(
          `[CuratedCluster] Anchor-split: release cap clamped ${rawRel.length} -> ${rel.length} member(s) for story ${story.signature}`,
        );
      }

      const relSet = new Set(rel);
      const keptMembers = story.synthMembers.filter((m) => !relSet.has(m.key));

      // Re-synthesize the SHRUNKEN cluster under the SAME signature so its anchor
      // reflects the kept members BEFORE committing any release. FAIL-OPEN: a
      // member is never dropped while a stale synthesis still describes the larger
      // (pre-split) cluster — so `resynthPersisted` turns true only after BOTH
      // synthesizeStory returns a non-null result AND upsertCuratedStorySynthesis
      // resolves. If synthesis returns null, we skip the commit; if the upsert
      // throws, the catch below skips it too. Either way the cluster is left
      // intact with its original (valid) synthesis.
      let resynthPersisted = false;
      let corroborated: boolean | null = null;
      const result = await synthesizeStory(keptMembers, signal);
      if (result) {
        const headline = result.headline.trim() || result.lede;
        await storage.upsertCuratedStorySynthesis({
          signature: story.signature,
          headline,
          lede: result.lede,
          facts: result.facts,
          spins: result.spins,
          alignments: result.alignments,
          attributedClaims: result.attributedClaims,
          contentHash: synthesisContentHash(keptMembers),
          corroborated: result.corroborated,
        });
        resynthPersisted = true;
        corroborated = result.corroborated;
      }

      const commit = resolveAnchorSplitCommit({
        releasedKeys: rel,
        resynthPersisted,
        corroborated,
        signature: story.signature,
        oversized,
      });
      if (commit.commitReleased.length === 0) {
        console.warn(
          `[CuratedCluster] Anchor-split: re-synthesis unavailable for story ${story.signature}; release of ${rel.length} member(s) SKIPPED (left intact)`,
        );
        continue;
      }
      if (!resynthPersisted && oversized) {
        degradedResynthSigs.add(story.signature);
        console.warn(
          `[CuratedCluster] Anchor-split: re-synthesis unavailable for OVERSIZED story ${story.signature}; releasing ${commit.commitReleased.length} different-event member(s) anyway (stale synthesis self-heals next pass)`,
        );
      }
      for (const k of commit.commitReleased) releasedKeys.add(k);
      if (oversized) oversizedReleased += commit.commitReleased.length;
      if (commit.dissolvedAdd) dissolvedAdds.add(commit.dissolvedAdd);
      if (commit.dissolvedRemove) dissolvedRemoves.add(commit.dissolvedRemove);
      console.log(
        `[CuratedCluster] Anchor-split: released ${commit.commitReleased.length} different-event member(s) from story ${story.signature} (kept ${keptMembers.length})`,
      );
    } catch (err) {
      console.warn(
        '[CuratedCluster] Anchor-split classify/resynth errored (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }
  }
  // Force a one-shot re-synthesis next pass for any story released in the degraded
  // (no-resynth) oversized path, so its persisted synthesis can never keep
  // describing the pre-split (larger) member set once the AI provider recovers.
  if (degradedResynthSigs.size > 0) {
    try {
      await storage.bustCuratedStorySynthesisContentHash([...degradedResynthSigs]);
    } catch (err) {
      console.warn(
        '[CuratedCluster] Anchor-split: failed to bust degraded synthesis contentHash (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }
  }
  return result();
}

// Snapshot each FORMED story into the historical archive. Keyed by clusterId
// (which IS the synthesis signature), so a recurring story upserts a single row
// (firstSeenAt preserved). Only fully-synthesized stories (with a generalized
// headline) are archived — a story that just formed gets archived on the next
// pass once its synthesis lands. Reuses the synthesis cache for headline/lede/
// facts/spins and the URL-keyed classification overlay for region/country.
const CURATED_ARCHIVE_RETENTION_DAYS = 90;

// Flight-recorder archive counters returned by archiveFormedStories. rowsSeen =
// distinct formed stories considered; the three branch counts (exactUpdates,
// carryForwardMerges, inserted) sum to the number actually written and reveal
// churn (lots of carry_forward / inserts = membership is thrashing).
export interface CuratedArchiveMetrics {
  rowsSeen: number;
  exactUpdates: number;
  carryForwardMerges: number;
  inserted: number;
  absorbedDuplicates: number;
  skippedUnsynthesized: number;
}

export async function archiveFormedStories(
  members: Array<Omit<CuratedClusterMember, 'id' | 'createdAt'>>,
  // Re-partition lineage per FINAL clusterId (Task #391). When present, each
  // child's archive row is stamped with its splitLineageKey so the carry-forward/
  // absorb step NEVER matches across sibling children of the same split parent.
  lineageBySignature?: Map<string, string | null>,
): Promise<CuratedArchiveMetrics> {
  const metrics: CuratedArchiveMetrics = {
    rowsSeen: 0,
    exactUpdates: 0,
    carryForwardMerges: 0,
    inserted: 0,
    absorbedDuplicates: 0,
    skippedUnsynthesized: 0,
  };
  if (members.length === 0) {
    // Still age out anything past retention even when nothing formed this pass.
    await storage.pruneCuratedStoryArchive(CURATED_ARCHIVE_RETENTION_DAYS);
    return metrics;
  }

  const synthesisMap = await storage.getCuratedStorySynthesisMap();

  // Group members by clusterId (= signature).
  const groups = new Map<string, Array<Omit<CuratedClusterMember, 'id' | 'createdAt'>>>();
  for (const m of members) {
    const g = groups.get(m.clusterId) ?? [];
    g.push(m);
    groups.set(m.clusterId, g);
  }

  // Look up content-based geography for each representative URL (the article's
  // SUBJECT geography, never the outlet's origin).
  const repByCluster = new Map<string, Omit<CuratedClusterMember, 'id' | 'createdAt'>>();
  for (const [clusterId, g] of Array.from(groups.entries())) {
    repByCluster.set(clusterId, g.find((m) => m.isRepresentative) ?? g[0]);
  }
  const repUrls = Array.from(repByCluster.values())
    .map((r) => r?.url)
    .filter((u): u is string => !!u);
  const classMap = await storage.getCuratedClassificationsByUrls(repUrls);

  metrics.rowsSeen = groups.size;
  let archived = 0;
  for (const [clusterId, g] of Array.from(groups.entries())) {
    const synth = synthesisMap.get(clusterId);
    if (!synth || !synth.headline || !synth.headline.trim()) {
      metrics.skippedUnsynthesized++; // not yet synthesized — archives next pass
      continue;
    }
    const rep = repByCluster.get(clusterId);
    const cls = rep?.url ? classMap.get(rep.url) : undefined;
    const spins = (synth.spins ?? {}) as Record<string, string>;
    const memberSnapshots: CuratedArchiveMember[] = g.map((m) => ({
      source: m.source,
      title: m.title,
      url: m.url,
      behaviorClass: m.behaviorClass,
      behaviorLabel: m.behaviorLabel ?? null,
      spin: spins[`${m.itemType}:${m.itemId}`] ?? null,
      // Snapshot the article's published date so the archive reads the same as
      // the live feed; omit (null) when genuinely unknown, never fabricated.
      publishedAt: m.publishedAt ? new Date(m.publishedAt).toISOString() : null,
    }));
    const branch = await storage.upsertCuratedStoryArchive({
      signature: clusterId,
      headline: synth.headline,
      lede: synth.lede,
      facts: synth.facts ?? [],
      attributedClaims: synth.attributedClaims ?? [],
      category: rep?.category ?? cls?.category ?? null,
      region: cls?.region ?? null,
      country: cls?.country ?? null,
      sourceCount: g.length,
      repTitle: rep?.title ?? null,
      repSource: rep?.source ?? null,
      repUrl: rep?.url ?? null,
      ogImageUrl: rep?.ogImageUrl ?? null,
      members: memberSnapshots,
      splitLineageKey: lineageBySignature?.get(clusterId) ?? null,
    });
    if (branch.action === 'exact') metrics.exactUpdates++;
    else if (branch.action === 'carry_forward') metrics.carryForwardMerges++;
    else metrics.inserted++;
    metrics.absorbedDuplicates += branch.absorbed;
    archived++;
  }

  await storage.pruneCuratedStoryArchive(CURATED_ARCHIVE_RETENTION_DAYS);
  console.log(
    `[CuratedCluster] Archive — upserted ${archived} stories ` +
      `(exact ${metrics.exactUpdates}, carry-forward ${metrics.carryForwardMerges}, ` +
      `insert ${metrics.inserted}, absorbed ${metrics.absorbedDuplicates}; ` +
      `retention ${CURATED_ARCHIVE_RETENTION_DAYS}d)`,
  );
  return metrics;
}
