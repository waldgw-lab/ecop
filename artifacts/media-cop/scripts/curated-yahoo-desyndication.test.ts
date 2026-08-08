/**
 * Regression test for Yahoo News de-syndication (Task #1057).
 *
 * Yahoo News is a syndication aggregator: its items originate at AP, Reuters,
 * etc., but the URL domain is yahoo.com. Curated ingest inspects a Yahoo article
 * page's meta / JSON-LD for the REAL publisher and re-attributes to it, so the
 * attach-only "Yahoo News" registry entry is only the fallback of last resort.
 *
 * This exercises the PURE extractor (extractSyndicatedPublisherFromHtml — no
 * network) against saved fixtures for the extraction strategies (JSON-LD
 * provider/publisher, Yahoo's rendered attribution markup, meta tags), plus the
 * URL host detector. It fails loudly if extraction stops finding the real
 * publisher or starts returning Yahoo's own name.
 *
 * No test framework is configured — run directly with tsx:
 *   npx tsx scripts/curated-yahoo-desyndication.test.ts
 * Exit 0 = pass, 1 = fail.
 */
import {
  isYahooSyndicationUrl,
  extractSyndicatedPublisherFromHtml,
} from '../server/syndicationResolver';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok   - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// URL host detection.
// ---------------------------------------------------------------------------
console.log('URL host detection:');
check('news.yahoo.com is syndication', isYahooSyndicationUrl('https://news.yahoo.com/some-article-123.html'));
check('www.yahoo.com is syndication', isYahooSyndicationUrl('https://www.yahoo.com/news/x.html'));
check('finance.yahoo.com is syndication', isYahooSyndicationUrl('https://finance.yahoo.com/news/x.html'));
check('apnews.com is NOT syndication', !isYahooSyndicationUrl('https://apnews.com/article/x'));
check('notyahoo.com.evil.com host anchored', !isYahooSyndicationUrl('https://yahoo.com.evil.com/x'));
check('malformed url is not syndication', !isYahooSyndicationUrl('not a url'));

// ---------------------------------------------------------------------------
// Strategy 1: JSON-LD provider (most reliable).
// ---------------------------------------------------------------------------
console.log('JSON-LD extraction:');
const jsonLdProvider = `<!doctype html><html><head>
  <meta property="og:site_name" content="Yahoo">
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"NewsArticle","headline":"Test",
   "provider":{"@type":"Organization","name":"Associated Press"},
   "publisher":{"@type":"Organization","name":"Yahoo News"}}
  </script>
</head><body></body></html>`;
check(
  'JSON-LD provider beats publisher/og:site_name',
  extractSyndicatedPublisherFromHtml(jsonLdProvider) === 'Associated Press',
  extractSyndicatedPublisherFromHtml(jsonLdProvider) || 'null',
);

const jsonLdGraph = `<!doctype html><html><head>
  <script type="application/ld+json">
  {"@graph":[{"@type":"WebPage"},{"@type":"NewsArticle",
   "sourceOrganization":{"@type":"Organization","name":"Reuters"}}]}
  </script>
</head><body></body></html>`;
check(
  '@graph + sourceOrganization resolves',
  extractSyndicatedPublisherFromHtml(jsonLdGraph) === 'Reuters',
  extractSyndicatedPublisherFromHtml(jsonLdGraph) || 'null',
);

// ---------------------------------------------------------------------------
// Strategy 2: Yahoo's rendered provider attribution markup.
// ---------------------------------------------------------------------------
console.log('DOM attribution extraction:');
const domProvider = `<!doctype html><html><head></head><body>
  <div class="caas-attr">
    <a class="caas-attr-provider" href="/x">Bloomberg</a>
  </div>
</body></html>`;
check(
  'caas-attr-provider element resolves',
  extractSyndicatedPublisherFromHtml(domProvider) === 'Bloomberg',
  extractSyndicatedPublisherFromHtml(domProvider) || 'null',
);

const domAttr = `<!doctype html><html><body>
  <span data-wf-provider="The Guardian"></span>
</body></html>`;
check(
  'data-wf-provider attribute resolves',
  extractSyndicatedPublisherFromHtml(domAttr) === 'The Guardian',
  extractSyndicatedPublisherFromHtml(domAttr) || 'null',
);

// ---------------------------------------------------------------------------
// Strategy 3: meta fallback.
// ---------------------------------------------------------------------------
console.log('meta fallback:');
const metaProvider = `<!doctype html><html><head>
  <meta name="provider" content="Agence France-Presse">
</head><body></body></html>`;
check(
  'meta[name=provider] resolves',
  extractSyndicatedPublisherFromHtml(metaProvider) === 'Agence France-Presse',
  extractSyndicatedPublisherFromHtml(metaProvider) || 'null',
);

// ---------------------------------------------------------------------------
// Negative cases: never return Yahoo's own name; unresolvable pages return null.
// ---------------------------------------------------------------------------
console.log('negative cases:');
const yahooOnly = `<!doctype html><html><head>
  <meta property="og:site_name" content="Yahoo">
  <script type="application/ld+json">
  {"@type":"NewsArticle","provider":{"@type":"Organization","name":"Yahoo News"}}
  </script>
</head><body></body></html>`;
check(
  'pure-Yahoo page returns null (falls back to registry)',
  extractSyndicatedPublisherFromHtml(yahooOnly) === null,
  String(extractSyndicatedPublisherFromHtml(yahooOnly)),
);
check('empty html returns null', extractSyndicatedPublisherFromHtml('') === null);
check(
  'plain page with no attribution returns null',
  extractSyndicatedPublisherFromHtml('<html><body><p>hi</p></body></html>') === null,
);
const malformedLd = `<html><head><script type="application/ld+json">{ not json </script>
  <meta name="provider" content="Politico"></head><body></body></html>`;
check(
  'malformed JSON-LD skipped, meta still works',
  extractSyndicatedPublisherFromHtml(malformedLd) === 'Politico',
  extractSyndicatedPublisherFromHtml(malformedLd) || 'null',
);

// ---------------------------------------------------------------------------
console.log(
  failures === 0
    ? '\n[curated-yahoo-desyndication] PASS'
    : `\n[curated-yahoo-desyndication] FAIL (${failures} failure(s))`,
);
process.exit(failures === 0 ? 0 : 1);
