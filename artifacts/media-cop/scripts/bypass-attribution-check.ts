// Verification gate for the bypass-host attribution guard (Task #1114).
// Pure-function checks on host detection / embedded-target extraction /
// junk-label rules, plus one registry-backed resolution pass (dev DB).
// Run: npx tsx scripts/bypass-attribution-check.ts
import {
  isBypassAttributionHost,
  extractBypassTargetUrl,
  resolveBypassAttribution,
  isJunkBypassLabel,
} from '../server/curatedIngest';
import { buildOutletIndex } from '../shared/outletRegistry';
import { storage } from '../server/storage';

let failures = 0;
const expect = (name: string, actual: unknown, expected: unknown) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} → ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
};

// Host detection: exact hostname matching, never substring.
expect('archive.ph is bypass', isBypassAttributionHost('https://archive.ph/AbCd1'), true);
expect('web.archive.org is bypass', isBypassAttributionHost('https://web.archive.org/web/2026/https://x.com/'), true);
expect('12ft.io is bypass', isBypassAttributionHost('https://12ft.io/proxy?q=https://a.com'), true);
expect('cnn.com is NOT bypass', isBypassAttributionHost('https://www.cnn.com/2026/x'), false);
expect('lookalike notarchive.ph.evil.com is NOT bypass', isBypassAttributionHost('https://notarchive.ph.evil.com/x'), false);
expect('lookalike myarchive.org is NOT bypass', isBypassAttributionHost('https://myarchive.org/x'), false);
expect('bad url is NOT bypass', isBypassAttributionHost('not a url'), false);

// Embedded-target extraction.
expect('archive.ph short code → null', extractBypassTargetUrl('https://archive.ph/AbCd1'), null);
expect('archive.ph embedded target', extractBypassTargetUrl('https://archive.ph/o/AbCd1/https://www.wsj.com/politics/x'), 'https://www.wsj.com/politics/x');
expect('archive.today ?url= param', extractBypassTargetUrl('https://archive.today/newest?url=https://www.ft.com/content/abc'), 'https://www.ft.com/content/abc');
expect('wayback embedded target', extractBypassTargetUrl('https://web.archive.org/web/20260101000000/https://www.reuters.com/world/us/foo/'), 'https://www.reuters.com/world/us/foo/');
expect('collapsed scheme healed', extractBypassTargetUrl('https://web.archive.org/web/20260101/https:/www.nytimes.com/2026/01/01/us/x.html'), 'https://www.nytimes.com/2026/01/01/us/x.html');
expect('12ft percent-encoded ?q=', extractBypassTargetUrl('https://12ft.io/proxy?q=https%3A%2F%2Fwww.washingtonpost.com%2Fnational-security%2Fx'), 'https://www.washingtonpost.com/national-security/x');
expect('nested bypass target rejected', extractBypassTargetUrl('https://archive.ph/o/x/https://web.archive.org/web/2026/https://a.com/'), null);
expect('non-bypass url → null', extractBypassTargetUrl('https://www.cnn.com/x'), null);

// Junk-label detection (only these may be replaced by a hostname fallback).
expect('junk: Archive', isJunkBypassLabel('Archive'), true);
expect('junk: archive.ph', isJunkBypassLabel('archive.ph'), true);
expect('junk: Wayback Machine', isJunkBypassLabel('Wayback Machine'), true);
expect('junk: Team Submission', isJunkBypassLabel('Team Submission'), true);
expect('junk: empty', isJunkBypassLabel(''), true);
expect('legit: Wall Street Journal', isJunkBypassLabel('Wall Street Journal'), false);

(async () => {
  const index = buildOutletIndex(await storage.getOutletRegistry());
  // Junk label + registered target → canonical name (or hostname if WSJ absent
  // from the registry — either way it must NOT stay "Archive").
  const wsj = resolveBypassAttribution('https://archive.ph/o/AbCd1/https://www.wsj.com/politics/x', 'Archive', index);
  console.log(`registry resolution for wsj.com target → ${JSON.stringify(wsj)}`);
  if (!wsj || wsj.toLowerCase() === 'archive') {
    failures++;
    console.log('FAIL wsj.com target should re-attribute away from "Archive"');
  }
  expect('unregistered target + junk label → hostname', resolveBypassAttribution('https://archive.ph/o/A/https://obscure-blog-xyz.example/post', 'Archive', index), 'obscure-blog-xyz.example');
  expect('unregistered target + legit label kept', resolveBypassAttribution('https://archive.ph/o/A/https://obscure-blog-xyz.example/post', 'Some Real Paper', index), null);
  expect('short code keeps label', resolveBypassAttribution('https://archive.ph/AbCd1', 'Archive', index), null);
  expect('short code exposes no target for boot heal', extractBypassTargetUrl('https://archive.ph/AbCd1'), null);
  expect('already-healed hostname is not junk', isJunkBypassLabel('obscure-blog-xyz.example'), false);
  expect('null index still gives hostname for junk label', resolveBypassAttribution('https://archive.ph/o/A/https://obscure-blog-xyz.example/post', 'Archive', null), 'obscure-blog-xyz.example');
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
