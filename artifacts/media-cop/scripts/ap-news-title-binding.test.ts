/**
 * AP URL/title binding regression.
 *
 * AP section cards repeat one article URL across image, caption, headline, and
 * teaser links. The parser must choose explicit headline/accessibility text
 * independent of DOM order and must never let a caption/teaser poison URL dedup.
 */
import {
  bindAPTitleToArticlePage,
  extractAPCanonicalTitle,
  parseAPSectionHtml,
} from '../server/apNewsBot';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`[ap-title-binding] OK   ${name}`);
  else {
    failed++;
    console.error(`[ap-title-binding] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const yemenUrl = 'https://apnews.com/article/yemen-houthis-attacks-iran-us-explainer-6d79ab62dc697281ba5be0352e95b2c5';
const fixture = `
  <article class="PagePromo">
    <a class="Link" href="${yemenUrl}">
      <span class="PagePromoContentIcons-text">Iran-backed Houthi fighters gather during a rally in Yemen. (AP Photo)</span>
    </a>
    <a class="Link" href="${yemenUrl}">
      <span class="PagePromo-description">Yemen's Houthi rebels claimed responsibility for deadly attacks this week.</span>
    </a>
    <a class="Link" aria-label="How the Iran-backed Houthis’ claims of deadly attacks are stoking fears of a wider regional conflict" href="${yemenUrl}">
      <img alt="">
    </a>
    <a class="Link" href="${yemenUrl}">
      <span class="PagePromo-title">How the Iran-backed Houthis’ claims of deadly attacks are stoking fears of a wider regional conflict</span>
    </a>
  </article>
  <article>
    <a href="/article/second-story-1234567890abcdef">
      <span class="PagePromo-title">A second valid AP headline remains independently bound</span>
    </a>
  </article>
`;

const parsed = parseAPSectionHtml(fixture);
const yemen = parsed.find(item => item.normalizedUrl === yemenUrl);
check('one candidate emitted per normalized URL', parsed.length === 2, `got ${parsed.length}`);
check('Yemen URL is present', !!yemen);
check(
  'explicit headline wins over earlier caption and teaser links',
  yemen?.title === 'How the Iran-backed Houthis’ claims of deadly attacks are stoking fears of a wider regional conflict',
  `got ${JSON.stringify(yemen?.title)}`,
);
check('relative AP article URL is absolutized',
  parsed.some(item => item.url === 'https://apnews.com/article/second-story-1234567890abcdef'));
check(
  'article-page canonical title overrides any section-page mismatch',
  extractAPCanonicalTitle(`
    <html lang="en">
    <meta property="og:title" content="How the Iran-backed Houthis’ claims of deadly attacks are stoking fears of a wider regional conflict">
    <h1>Untrusted fallback</h1>
    </html>
  `) === 'How the Iran-backed Houthis’ claims of deadly attacks are stoking fears of a wider regional conflict',
);
check(
  'canonical binding replaces a substantive cross-wire',
  bindAPTitleToArticlePage(
    "I'm very good at grass. Why Trump goes into the weeds",
    `<html lang="en"><meta property="og:title" content="How the Iran-backed Houthis’ claims of deadly attacks are stoking fears of a wider regional conflict"></html>`,
  ) === 'How the Iran-backed Houthis’ claims of deadly attacks are stoking fears of a wider regional conflict',
);
check(
  'typography-only canonical differences preserve the existing title',
  bindAPTitleToArticlePage(
    'Romania’s reactor remains online',
    `<html lang="en"><meta property="og:title" content="Romania's reactor remains online"></html>`,
  ) === 'Romania’s reactor remains online',
);
check(
  'non-English AP article pages fail closed',
  bindAPTitleToArticlePage(
    'English section headline',
    `<html lang="es"><meta property="og:title" content="Titular en español"></html>`,
  ) === null,
);

process.exit(failed === 0 ? 0 : 1);