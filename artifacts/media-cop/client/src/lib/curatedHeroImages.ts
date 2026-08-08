export interface CuratedHeroImageStory {
  ogImageUrl?: string | null;
  memberImages?: string[] | null;
  source?: string | null;
  sourceCount?: number | null;
}

/**
 * Build a cluster carousel only from the server-approved story image fields.
 * Raw member images are intentionally not accepted here: attached/contrast
 * sources remain visible in story.members but are not eligible story media.
 */
export function buildCuratedHeroImages(
  story: CuratedHeroImageStory | null | undefined,
  resolveImage: (
    url: string | null | undefined,
    allowOutletFallback: boolean,
    source?: string | null,
  ) => string | null,
): string[] {
  if (!story) return [];

  const approvedImages =
    story.memberImages != null
      ? story.memberImages
      : story.ogImageUrl
        ? [story.ogImageUrl]
        : [];

  return Array.from(
    new Set(
      approvedImages
        .map((url) =>
          resolveImage(url, (story.sourceCount ?? 0) <= 1, story.source),
        )
        .filter((url): url is string => !!url),
    ),
  );
}