import { readFileSync } from 'node:fs';

const checks: Array<[string, boolean]> = [];
const check = (name: string, condition: boolean) => checks.push([name, condition]);

const files = [
  ['generic website scrapers', 'server/curatedWebScraper.ts'],
  ['generic off-host scrapers', 'server/curatedOffHostBot.ts'],
  ['AP website scraper', 'server/apNewsBot.ts'],
  ['Reuters off-host scraper', 'server/reutersBot.ts'],
] as const;

for (const [label, path] of files) {
  const source = readFileSync(path, 'utf8');
  check(`${label} persist through shared telemetry merge`, source.includes('mergeCuratedIntakeFeedStats'));
  check(`${label} count fetch failures`, source.includes('fetchFailures++'));
  check(`${label} store a short fetch error`, source.includes('lastFetchError = shortFetchError'));
  check(`${label} clear stale errors on a healthy run`, source.includes('lastFetchError: string | null = null'));
  check(
    `${label} do not leave the shared telemetry row admission-pending`,
    source.includes('admissionPending: false'),
  );
}

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
}
if (failed.length > 0) process.exit(1);