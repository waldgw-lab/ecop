/**
 * Curated Top Stories ranking calibration.
 *
 * This is deliberately part of the EXISTING read-time blend (importance +
 * corroboration), not a new intake/classification stage. The shared analyzers
 * remain responsible for the machine P-score; this pure helper keeps two
 * long-running local-conflict tracks from entering the HIGH ranking band solely
 * because many outlets repeated the same locally contained development.
 */
import { hasDirectUsConflictImplication } from './scoreAdjustments';

export const CORROBORATION_PER_SOURCE = 7;
export const CORROBORATION_MAX_BOOST = 50;
export const LOCAL_CONFLICT_MAX_PRIORITY = 69;

export type CuratedTopStoryRankInput = {
  priorityScore?: number | null;
  priorityOverride?: number | null;
  corroboratingSourceCount?: number | null;
  sourceCount?: number | null;
  title?: string | null;
  displayTitle?: string | null;
  headline?: string | null;
  summary?: string | null;
  lede?: string | null;
  facts?: string[] | null;
  conflictTrack?: string | null;
};

const TARGET_LOCAL_CONFLICT_TRACKS = new Set([
  'Russia-Ukraine War',
  'Israel-Hamas / Gaza',
]);

// Text fallback for the brief interval before classification lands. Require a
// theater-specific term rather than a bare "Russia" or "Israel" mention so an
// unrelated domestic/political story is never swept into this calibration.
const RUSSIA_UKRAINE_THEATER =
  /\b(?:ukraine|ukrainian|kyiv|kiev|kherson|kharkiv|zaporizh\w*|donbas|donetsk|luhansk|crimea|odesa|dnipro|pokrovsk)\b/i;
const ISRAEL_GAZA_THEATER =
  /\b(?:gaza|hamas|palestin\w*|rafah|khan younis|deir al-balah|jabalia|hind rajab)\b/i;
const ROUTINE_LOCAL_INCIDENT =
  /\b(?:criminal probes?|investigat\w*|troop conduct|killings?|deaths?|dead|injur\w*|wound\w*|casualt\w*|drone strike|shell\w*|raid\w*|isolated attack|overnight attack|battlefield update|advance\w* near|paramedics?|rescue workers?|minibus|bus|vehicle|civilians?|village)\b/i;
const THEATER_CHANGING_DEVELOPMENT =
  /\b(?:new front|major offensive|large-scale offensive|strategic breakthrough|capture\w* (?:a )?(?:major city|regional capital|capital)|fall\w* of (?:a )?(?:major city|regional capital|capital)|leadership decapitation|assassinat\w* (?:the )?(?:president|prime minister|commander|leader)|full-scale invasion|general mobilization|declare\w* war|regime collapse|government collapse|annex\w*|nuclear|chemical weapons?|biological weapons?|weapons? of mass destruction|wmd|mass-casualty attack)\b/i;

function storyText(story: CuratedTopStoryRankInput): string {
  return [
    story.headline,
    story.displayTitle,
    story.title,
    story.lede,
    story.summary,
    ...(story.facts ?? []),
  ].filter(Boolean).join(' ');
}

export function isTargetLocalConflictStory(
  story: CuratedTopStoryRankInput,
): boolean {
  if (
    story.conflictTrack &&
    TARGET_LOCAL_CONFLICT_TRACKS.has(story.conflictTrack)
  ) {
    return true;
  }
  const text = storyText(story);
  return RUSSIA_UKRAINE_THEATER.test(text) || ISRAEL_GAZA_THEATER.test(text);
}

export function isRoutineTargetLocalConflictStory(
  story: CuratedTopStoryRankInput,
): boolean {
  if (!isTargetLocalConflictStory(story)) return false;
  const text = storyText(story);
  return (
    ROUTINE_LOCAL_INCIDENT.test(text) &&
    !THEATER_CHANGING_DEVELOPMENT.test(text)
  );
}

export function isTargetLocalConflictWithoutDirectUsImplication(
  story: CuratedTopStoryRankInput,
): boolean {
  if (!isRoutineTargetLocalConflictStory(story)) return false;
  return !hasDirectUsConflictImplication(
    storyText(story),
    null,
    story.conflictTrack,
  );
}

/**
 * P-score shown in Curated. Human pins are authoritative and are never changed
 * by this machine calibration. Unpinned local-conflict rows without a concrete
 * U.S. implication remain at the top of MODERATE (P69) at most.
 */
export function calibrateCuratedTopStoryPriority(
  story: CuratedTopStoryRankInput,
): number {
  const base = Number.isFinite(story.priorityScore)
    ? Number(story.priorityScore)
    : 0;
  if (story.priorityOverride != null) return base;
  return isTargetLocalConflictWithoutDirectUsImplication(story)
    ? Math.min(base, LOCAL_CONFLICT_MAX_PRIORITY)
    : base;
}

/**
 * Final score used to order Top Stories.
 *
 * A manual pin already produced `priorityScore` on the standard decay curve, so
 * it is the complete final rank: corroboration must not silently lift it again.
 * For unpinned routine local-conflict coverage, corroboration may help order
 * items within MODERATE but can never create a HIGH score.
 */
export function computeCuratedTopStoryBlendScore(
  story: CuratedTopStoryRankInput,
): number {
  const base = calibrateCuratedTopStoryPriority(story);
  if (story.priorityOverride != null) return base;

  const extra = Math.max(
    0,
    (story.corroboratingSourceCount ?? story.sourceCount ?? 1) - 1,
  );
  const corroborationBoost = Math.min(
    CORROBORATION_MAX_BOOST,
    extra * CORROBORATION_PER_SOURCE,
  );
  const blended = base + corroborationBoost;

  return isTargetLocalConflictWithoutDirectUsImplication(story)
    ? Math.min(blended, LOCAL_CONFLICT_MAX_PRIORITY)
    : blended;
}