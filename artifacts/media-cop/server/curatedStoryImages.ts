export interface CuratedImageCandidate {
  imageUrl: string | null | undefined;
  isSocial: boolean;
  sourceIdentifier?: string | null;
  otherSourceType?: string | null;
}

const CURATED_STORY_IMAGE_SOURCE_IDENTIFIERS = new Set([
  'news-us-domestic',
  'news-international',
  'release-us-official',
  'release-international',
]);

/**
 * Only ordinary news and non-CPC official releases may supply a Curated story
 * photo. CPC/SWL/EPC, social, and every registry "Other source" classification
 * remain visible as sources but are media-ineligible. Missing or malformed
 * registry classification fails closed so alias/domain drift cannot turn an
 * attach-only source into a photo provider.
 */
export function isEligibleCuratedStoryImageCandidate(
  candidate: CuratedImageCandidate,
): candidate is CuratedImageCandidate & { imageUrl: string } {
  const sourceIdentifier = candidate.sourceIdentifier?.trim().toLowerCase() ?? null;
  const otherSourceType = candidate.otherSourceType?.trim().toLowerCase() ?? null;
  return (
    !candidate.isSocial &&
    otherSourceType === null &&
    sourceIdentifier !== null &&
    CURATED_STORY_IMAGE_SOURCE_IDENTIFIERS.has(sourceIdentifier) &&
    typeof candidate.imageUrl === 'string' &&
    candidate.imageUrl.length > 0
  );
}

/**
 * Select Curated story images from ordered candidates.
 *
 * Social, CPC/SWL/EPC, and registry "Other source" members remain in the
 * story/source list, but are never eligible to supply either the card image or
 * a carousel image. The caller controls ordering and hidden-image policy so
 * this stays a pure display invariant.
 */
export function selectCuratedStoryImages(
  primaryCandidates: ReadonlyArray<CuratedImageCandidate>,
  memberCandidates: ReadonlyArray<CuratedImageCandidate>,
  hiddenImages: ReadonlySet<string>,
): { ogImageUrl: string | null; memberImages: string[] } {
  const eligible = (candidate: CuratedImageCandidate): candidate is CuratedImageCandidate & { imageUrl: string } =>
    isEligibleCuratedStoryImageCandidate(candidate) &&
    !hiddenImages.has(candidate.imageUrl);

  const ogImageUrl = primaryCandidates.find(eligible)?.imageUrl ?? null;
  const memberImages = Array.from(
    new Set(
      [
        ogImageUrl,
        ...memberCandidates.filter(eligible).map((candidate) => candidate.imageUrl),
      ].filter((url): url is string => !!url),
    ),
  );

  return { ogImageUrl, memberImages };
}