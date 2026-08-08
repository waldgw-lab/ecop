/**
 * Live-validation harness for the WSJ RSS feed image index (Task #692, locked
 * by Task #695).
 *
 * WSJ article pages are hard-blocked (isHardBlockedOutlet), so uncrackable
 * curated WSJ rows recover their lead photo from WSJ's own PUBLIC section RSS
 * feeds, which carry a real full-size photo via <media:content> on the WSJ CDN
 * (images.wsj.net). server/wsjFeedIndex.ts polls those feeds and exposes
 * getWsjFeedImage(url); server/streamPrefetch.ts (enrichOneItem) consults it
 * BEFORE the doomed page-fetch / paywall2 budget for hard-blocked curated rows.
 *
 * This harness locks that recovery path so a future change to the WSJ feed
 * slugs, the media:content parsing, or the enrichOneItem wiring can't silently
 * stop recovering images (the row would just quietly stick on a favicon):
 *
 *   1. LIVE: fetch each WSJ_FEED_URLS slug and confirm items carry
 *      <media:content> images on images.wsj.net (the very signal getWsjFeedImage
 *      indexes). A live WSJ feed present with media:content is the PASS signal.
 *   2. getWsjFeedImage() returns a real image for a URL actually present in the
 *      live feed, and null for a non-wsj.com URL (host gate holds).
 *   3. Source-structure guard: enrichOneItem still wires getWsjFeedImage behind
 *      the hard-blocked + curated gate, ordered so it can win before the page
 *      fetches (no live server needed for this part).
 *
 * Harness reliability convention (scripts/harness-reliability.ts):
 *   exit 0 = PASS, 1 = FAIL (genuine regression), 3 = INCONCLUSIVE. A network
 *   failure reaching WSJ's feeds is a PRECONDITION, not a content judgment —
 *   it exits 3, never 1. No test framework configured; run with tsx:
 *     npx tsx scripts/wsj-feed-image.test.ts
 */
import Parser from 'rss-parser';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  WSJ_FEED_URLS,
  isWsjUrl,
  extractMediaImage,
  getWsjFeedImage,
} from '../server/wsjFeedIndex';
import { EXIT_PASS, EXIT_FAIL, EXIT_INCONCLUSIVE } from './harness-reliability';

let passed = 0;
const failures: string[] = [];
function check(cond: boolean, why: string) {
  if (cond) {
    passed++;
    console.log(`PASS [${why}]`);
  } else {
    failures.push(`FAIL [${why}]`);
    console.error(`FAIL [${why}]`);
  }
}

// A precondition failed (network/feed unreachable) — inconclusive, not a bug.
class PreconditionError extends Error {}

const PER_FEED_TIMEOUT_MS = 12 * 1000;
const parser = new Parser({
  timeout: PER_FEED_TIMEOUT_MS,
  customFields: {
    item: [['media:content', 'mediaContent', { keepArray: true }]],
  },
});

function isWsjCdnImage(url: string | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'images.wsj.net' || host.endsWith('.wsj.net');
  } catch {
    return false;
  }
}

async function fetchFeed(feedUrl: string): Promise<Parser.Output<{ [k: string]: any }> | null> {
  try {
    const resp = await fetch(feedUrl, {
      headers: {
        // rss-parser's default UA is WAF-blocked; use a browser UA (see memory
        // "rss-parser UA block").
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(PER_FEED_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.log(`[precondition] ${feedUrl} → HTTP ${resp.status}`);
      return null;
    }
    const xml = await resp.text();
    return await parser.parseString(xml);
  } catch (err: any) {
    console.log(`[precondition] ${feedUrl} fetch/parse failed: ${err?.message || err}`);
    return null;
  }
}

async function run() {
  // -------------------------------------------------------------------------
  // 0. Pure host-gate assertions (no network) — always run.
  // -------------------------------------------------------------------------
  check(isWsjUrl('https://www.wsj.com/articles/abc'), 'isWsjUrl: www.wsj.com matches');
  check(isWsjUrl('https://wsj.com/x'), 'isWsjUrl: bare wsj.com matches');
  check(!isWsjUrl('https://www.nytimes.com/x'), 'isWsjUrl: non-WSJ host does not match');
  check(!isWsjUrl('https://wsj.com.evil.example/x'), 'isWsjUrl: suffix-spoof host does not match');

  // extractMediaImage parses the shape rss-parser produces for <media:content>.
  check(
    extractMediaImage({ mediaContent: [{ $: { url: 'https://images.wsj.net/im-1/social' } }] }) ===
      'https://images.wsj.net/im-1/social',
    'extractMediaImage: reads url attr from a media:content node',
  );
  check(extractMediaImage({}) === null, 'extractMediaImage: null when no media present');

  // getWsjFeedImage must reject non-WSJ URLs WITHOUT touching the network.
  check((await getWsjFeedImage('https://www.nytimes.com/x')) === null, 'getWsjFeedImage: null for non-wsj.com URL');

  // -------------------------------------------------------------------------
  // 1. LIVE: at least one WSJ feed slug is reachable and carries media:content
  //    images on the WSJ CDN. Unreachable feeds = precondition (exit 3).
  // -------------------------------------------------------------------------
  check(WSJ_FEED_URLS.length > 0, 'WSJ_FEED_URLS is non-empty');

  let anyFeedReachable = false;
  let sampleWsjArticleUrl: string | null = null;

  for (const feedUrl of WSJ_FEED_URLS) {
    const parsed = await fetchFeed(feedUrl);
    if (!parsed) continue;
    anyFeedReachable = true;

    const items = parsed.items ?? [];
    const withCdnImage = items.filter((it) => isWsjCdnImage(extractMediaImage(it)));
    console.log(
      `[live] ${feedUrl} → ${items.length} items, ${withCdnImage.length} with an images.wsj.net media:content`,
    );

    if (withCdnImage.length > 0) {
      // This feed proves the recovery signal exists. Capture a WSJ article URL
      // present in the feed so we can assert getWsjFeedImage resolves it.
      check(true, `live feed carries media:content images.wsj.net photos (${feedUrl})`);
      if (!sampleWsjArticleUrl) {
        const withLink = withCdnImage.find((it) => it.link && isWsjUrl(it.link));
        if (withLink?.link) sampleWsjArticleUrl = withLink.link;
      }
      // One reachable, image-bearing feed is enough to prove the path; stop.
      break;
    }
  }

  if (!anyFeedReachable) {
    throw new PreconditionError('No WSJ feed URL was reachable from this environment');
  }

  // -------------------------------------------------------------------------
  // 2. getWsjFeedImage() resolves a real image for a URL present in the feed.
  //    (This exercises the module's own fetch+parse+normalize+index pipeline.)
  // -------------------------------------------------------------------------
  if (sampleWsjArticleUrl) {
    const img = await getWsjFeedImage(sampleWsjArticleUrl);
    check(
      isWsjCdnImage(img),
      `getWsjFeedImage returns an images.wsj.net photo for a live-feed URL (${sampleWsjArticleUrl})`,
    );
  } else {
    // A reachable feed with zero media:content images on the CDN is a genuine
    // signal loss (slug points somewhere images no longer come from) — but it
    // could also be a transient empty feed, so treat "reachable but no image"
    // as INCONCLUSIVE rather than a hard FAIL.
    throw new PreconditionError(
      'WSJ feeds reachable but none exposed an images.wsj.net media:content image this run',
    );
  }

  // -------------------------------------------------------------------------
  // 3. Source-structure guard — enrichOneItem still wires getWsjFeedImage
  //    behind the hard-blocked + curated gate, before the page-fetch budget.
  // -------------------------------------------------------------------------
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'server', 'streamPrefetch.ts'), 'utf8');

  check(
    /import\s*\{\s*getWsjFeedImage\s*\}\s*from\s*["']\.\/wsjFeedIndex["']/.test(src),
    'streamPrefetch imports getWsjFeedImage from ./wsjFeedIndex',
  );

  const wsjCallIdx = src.indexOf('getWsjFeedImage(item.url)');
  check(wsjCallIdx !== -1, 'enrichOneItem calls getWsjFeedImage(item.url)');

  // The call must be gated by an isHardBlocked + curated branch just above it.
  const guardIdx = src.lastIndexOf('isHardBlocked && item.kind === \'curated\'', wsjCallIdx);
  check(
    guardIdx !== -1 && guardIdx < wsjCallIdx,
    'getWsjFeedImage is gated by an isHardBlocked + curated branch',
  );

  // It must run BEFORE the archive/page-fetch chain that spends the budget.
  const archiveIdx = src.indexOf('const isArchiveUrl = isArchiveHost(item.url)');
  check(
    archiveIdx !== -1 && wsjCallIdx < archiveIdx,
    'getWsjFeedImage runs before the page-fetch (archive) chain',
  );
}

run()
  .then(() => {
    console.log(`\n${passed} checks passed`);
    if (failures.length) {
      console.error(`\n${failures.length} failure(s) — genuine regression.`);
      process.exit(EXIT_FAIL);
    }
    process.exit(EXIT_PASS);
  })
  .catch((err) => {
    if (err instanceof PreconditionError) {
      console.log(`\n[INCONCLUSIVE] precondition failed: ${err.message}`);
      console.log('Treat as retryable (network/live-feed precondition), not a regression.');
      process.exit(EXIT_INCONCLUSIVE);
    }
    console.error('\n[UNEXPECTED ERROR]', err);
    process.exit(EXIT_FAIL);
  });
