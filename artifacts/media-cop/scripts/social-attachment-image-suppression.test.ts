/**
 * Regression gate: attachment-only social posts remain valid source rows and
 * Truth Social keeps its own image, but social media can never become Curated
 * story media.
 *
 * Pure and deterministic: no database, network, browser, or AI.
 */
import { readFileSync } from 'node:fs';
import {
  isAttachmentOnlySocialContent,
  suppressAttachmentOnlySocialImage,
} from '../server/socialPostText';
import { normalizeXRelayPost } from '../server/xRelayService';
import {
  extractTruthSocialPayloadImage,
  filterTruthSocialPostImage,
} from '../server/truthSocialService';
import { selectCuratedStoryImages } from '../server/curatedStoryImages';
import { OTHER_SOURCE_TYPES } from '../shared/outletRegistry';
import { buildCuratedHeroImages } from '../client/src/lib/curatedHeroImages';

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`[social-attachment-image] OK   ${name}`);
  } else {
    console.error(`[social-attachment-image] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

const mediaImage = 'https://cdn.example/social-attachment.jpg';
const articleImage = 'https://news.example/article-photo.jpg';
const releaseImage = 'https://official.example/release-photo.jpg';

for (const content of ['', '   ', '[Media attachment]', 'media attachment', '<p>[MEDIA ATTACHMENT]</p>']) {
  check(
    `exact attachment-only marker recognized: ${JSON.stringify(content)}`,
    isAttachmentOnlySocialContent(content),
  );
  check(
    `exact attachment-only marker suppresses image: ${JSON.stringify(content)}`,
    suppressAttachmentOnlySocialImage(content, mediaImage) === null,
  );
}

for (const content of [
  'New imagery from the exercise.',
  'This post includes a media attachment with additional context.',
  '[Media attachment] shows the damaged runway after the strike.',
]) {
  check(
    `substantive social text preserved: ${JSON.stringify(content)}`,
    !isAttachmentOnlySocialContent(content) &&
      suppressAttachmentOnlySocialImage(content, mediaImage) === mediaImage,
  );
}

const xAttachmentOnly = normalizeXRelayPost({
  handle: 'SecWar',
  postId: 'x-media-only',
  content: '',
  image_url: mediaImage,
  video_url: 'https://cdn.example/source-video.mp4',
});
check('X relay retains attachment-only post', !!xAttachmentOnly);
check('X relay strips attachment-only still image', xAttachmentOnly?.imageUrl === null);
check(
  'X relay preserves attachment-only video media',
  xAttachmentOnly?.videoUrl === 'https://cdn.example/source-video.mp4',
);
check('X relay preserves linkable source URL', !!xAttachmentOnly?.xUrl);

const xSubstantive = normalizeXRelayPost({
  handle: 'SecWar',
  postId: 'x-substantive',
  content: 'Substantive operational update.',
  image_url: mediaImage,
});
check('X relay preserves substantive-post image', xSubstantive?.imageUrl === mediaImage);

check(
  'Truth Social preserves attachment-only image for its own card',
  filterTruthSocialPostImage('[Media attachment]', mediaImage) === mediaImage,
);
check(
  'Truth Social preserves substantive-post image',
  filterTruthSocialPostImage('Substantive statement from the account.', mediaImage) === mediaImage,
);
check(
  'Truth Social preserves image for exact production empty-HTML body',
  filterTruthSocialPostImage('<p></p>', mediaImage) === mediaImage,
);
check(
  'Truth Social recovers image from retained relay payload',
  extractTruthSocialPayloadImage(JSON.stringify({
    content: '<p></p>',
    media_attachments: [{ type: 'image', url: mediaImage }],
  })) === mediaImage,
);
check(
  'Truth Social ignores malformed retained relay payload',
  extractTruthSocialPayloadImage('{not-json') === null,
);

const selected = selectCuratedStoryImages(
  [
    { imageUrl: mediaImage, isSocial: true, sourceIdentifier: 'social-us-official' },
    { imageUrl: articleImage, isSocial: false, sourceIdentifier: 'news-us-domestic' },
  ],
  [
    { imageUrl: mediaImage, isSocial: true, sourceIdentifier: 'social-us-official' },
    { imageUrl: articleImage, isSocial: false, sourceIdentifier: 'news-us-domestic' },
    {
      imageUrl: 'https://news.example/second-article-photo.jpg',
      isSocial: false,
      sourceIdentifier: 'news-international',
    },
  ],
  new Set(),
);
check('attached social member cannot supply Curated card image', selected.ogImageUrl === articleImage);
check(
  'attached social member cannot enter Curated image carousel',
  !selected.memberImages.includes(mediaImage),
);
check(
  'non-social story photos remain in Curated carousel',
  selected.memberImages.includes(articleImage) &&
    selected.memberImages.includes('https://news.example/second-article-photo.jpg'),
);

const excludedClassImages = [
  { imageUrl: 'https://contrast.example/news.jpg', isSocial: false, sourceIdentifier: 'news-cpc' },
  { imageUrl: 'https://contrast.example/social.jpg', isSocial: false, sourceIdentifier: 'social-cpc' },
  { imageUrl: 'https://contrast.example/release.jpg', isSocial: false, sourceIdentifier: 'release-cpc' },
  {
    imageUrl: 'https://legacy.example/podcast.jpg',
    isSocial: false,
    otherSourceType: 'podcast',
  },
  {
    imageUrl: 'https://unregistered.example/photo.jpg',
    isSocial: false,
  },
  {
    imageUrl: 'https://malformed.example/photo.jpg',
    isSocial: false,
    sourceIdentifier: 'news-unknown',
  },
  {
    imageUrl: 'https://malformed-other.example/photo.jpg',
    isSocial: false,
    sourceIdentifier: 'news-unknown',
    otherSourceType: 'podcast',
  },
  ...OTHER_SOURCE_TYPES.map((otherSourceType) => ({
    imageUrl: `https://other.example/${otherSourceType}.jpg`,
    isSocial: otherSourceType === 'social',
    sourceIdentifier: 'other',
    otherSourceType,
  })),
];
const classificationSelected = selectCuratedStoryImages(
  [
    ...excludedClassImages,
    { imageUrl: articleImage, isSocial: false, sourceIdentifier: 'news-us-domestic' },
  ],
  [
    ...excludedClassImages,
    { imageUrl: releaseImage, isSocial: false, sourceIdentifier: 'release-us-official' },
  ],
  new Set(),
);
for (const candidate of excludedClassImages) {
  check(
    `${candidate.sourceIdentifier ?? 'missing'}/${candidate.otherSourceType ?? 'classified'} cannot supply Curated photos`,
    classificationSelected.ogImageUrl !== candidate.imageUrl &&
      !classificationSelected.memberImages.includes(candidate.imageUrl),
  );
}
check(
  'ordinary news still supplies the Curated card image',
  classificationSelected.ogImageUrl === articleImage,
);
check(
  'non-CPC official release photos remain eligible',
  classificationSelected.memberImages.includes(releaseImage),
);

const cgtnImage = 'https://news.cgtn.com/raw-member-photo.jpg';
const approvedCarouselImage = 'https://news.example/approved-carousel-photo.jpg';
const nestedMembers = [
  {
    source: 'CGTN',
    sourceIdentifier: 'news-cpc',
    behaviorClass: 'anchor-only',
    behaviorLabel: 'contrast',
    ogImageUrl: cgtnImage,
  },
  {
    source: 'Eligible News',
    sourceIdentifier: 'news-international',
    behaviorClass: 'corroborating',
    ogImageUrl: approvedCarouselImage,
  },
];
const clientHeroImages = buildCuratedHeroImages(
  {
    source: 'Eligible News',
    sourceCount: 2,
    ogImageUrl: approvedCarouselImage,
    memberImages: [approvedCarouselImage],
    // Deliberately model the production payload: raw nested images exist, but
    // buildCuratedHeroImages cannot consume them.
    members: nestedMembers,
  } as Parameters<typeof buildCuratedHeroImages>[0] & { members: typeof nestedMembers },
  (url) => url ?? null,
);
check(
  'detail carousel ignores raw nested CGTN/news-cpc member image',
  !clientHeroImages.includes(cgtnImage),
);
check(
  'detail carousel keeps server-approved contributing-news image',
  clientHeroImages.includes(approvedCarouselImage),
);

// Source-structure guards ensure future scraper/relay edits cannot bypass the
// centralized policy while keeping this gate pure.
for (const file of ['server/truthSocialScraper.ts', 'server/truthSocialBackupScraper.ts']) {
  const source = readFileSync(file, 'utf8');
  check(
    `${file} does not suppress attachment-only Truth Social images`,
    !source.includes('suppressAttachmentOnlySocialImage'),
  );
}
for (const file of ['server/truthSocialService.ts', 'server/routes.ts', 'server/scheduler.ts']) {
  const source = readFileSync(file, 'utf8');
  check(
    `${file} keeps centralized Truth Social avatar filtering`,
    source.includes('filterTruthSocialPostImage'),
  );
}

if (failures.length > 0) {
  console.error(`\n[social-attachment-image] FAIL — ${failures.length} assertion(s) failed`);
  process.exit(1);
}
console.log('\n[social-attachment-image] PASS — social cards keep media without leaking it into Curated stories');