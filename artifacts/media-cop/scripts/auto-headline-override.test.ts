// =============================================================================
// Gate: curated automated headline repair guard stack (Task #176 automated)
// -----------------------------------------------------------------------------
// Pure, deterministic unit test of server/curatedAutoHeadline.ts — the fail-
// closed gate that decides whether a paywall/CPC-bypass-recovered headline may
// replace a stale/generic curated headline as a DISPLAY-ONLY 'auto' override.
//
// No DB / no network. Exit 0 = all pass, 1 = a failure (per the gate runner
// convention in scripts/run-gates.ts).
//
// NOTE: the "a human ('human') override is never clobbered" property is enforced
// one layer down, in storage.setAutoCuratedHeadlineOverride's SQL
// `ON CONFLICT ... DO UPDATE ... WHERE provenance <> 'human'`, not in this pure
// gate. This test covers only the accept/reject decision logic.
// =============================================================================
import {
  evaluateAutoHeadline,
  sanitizeRecoveredHeadline,
  stripSiteSuffix,
  normalizeForCompare,
  isGenericHeadline,
  isBotWallHeadline,
  type AutoHeadlineInput,
} from '../server/curatedAutoHeadline';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// A matching source/item URL pair (bypass reports a tracking-param variant of
// the same article — normalizeIdentityUrl must collapse them to one identity).
const ITEM_URL = 'https://www.reuters.com/world/middle-east/iran-talks-2024-01-01/';
const SRC_URL_SAME = 'https://www.reuters.com/world/middle-east/iran-talks-2024-01-01/?utm_source=feed';
const SRC_URL_DIFF = 'https://www.reuters.com/world/europe/other-story-2024-02-02/';

function base(overrides: Partial<AutoHeadlineInput>): AutoHeadlineInput {
  return {
    storedTitle: 'Talks continue in the region',
    recoveredHeadline: 'Iran and world powers resume nuclear talks in Geneva amid tensions',
    recoveredSourceUrl: SRC_URL_SAME,
    itemUrl: ITEM_URL,
    isSocial: false,
    isTranslateSource: false,
    ...overrides,
  };
}

console.log('[auto-headline-override] guard stack');

// --- ACCEPT: a real, distinct headline whose source URL matches the item ------
{
  const r = evaluateAutoHeadline(base({}));
  check('accepts a valid recovered headline (matching identity, meaningful diff)',
    r.accept === true && r.reason === 'ok', `got ${JSON.stringify(r)}`);
  check('accepted headline is returned verbatim',
    r.headline === 'Iran and world powers resume nuclear talks in Geneva amid tensions');
}

// --- REJECT: identity mismatch (anti-smear) -----------------------------------
{
  const r = evaluateAutoHeadline(base({ recoveredSourceUrl: SRC_URL_DIFF }));
  check('rejects when the bypass source URL is a DIFFERENT article',
    r.accept === false && r.reason === 'identity-mismatch', `got ${JSON.stringify(r)}`);
}

// --- REJECT: no source URL (fail closed) --------------------------------------
{
  const r = evaluateAutoHeadline(base({ recoveredSourceUrl: null }));
  check('rejects when there is no source URL to bind identity',
    r.accept === false && r.reason === 'no-source-url', `got ${JSON.stringify(r)}`);
}

// --- REJECT: empty / missing recovered headline -------------------------------
{
  const r = evaluateAutoHeadline(base({ recoveredHeadline: '   ' }));
  check('rejects an empty recovered headline',
    r.accept === false && r.reason === 'empty', `got ${JSON.stringify(r)}`);
}

// --- REJECT: AI refusal text (via injected detector) --------------------------
{
  const r = evaluateAutoHeadline(
    base({ recoveredHeadline: 'I cannot provide a headline for this article as it may be harmful' }),
    { isRefusalText: (t) => /i cannot/i.test(t || '') },
  );
  check('rejects recovered text flagged as an AI refusal',
    r.accept === false && r.reason === 'refusal', `got ${JSON.stringify(r)}`);
}

// --- REJECT: too short --------------------------------------------------------
{
  const r = evaluateAutoHeadline(base({ recoveredHeadline: 'Short one' }));
  check('rejects a too-short headline',
    r.accept === false && r.reason === 'too-short', `got ${JSON.stringify(r)}`);
}

// --- REJECT: too long (paragraph blob, not a headline) ------------------------
{
  const blob = 'Global diplomatic developments continue steadily '.repeat(8); // > 250 chars
  const r = evaluateAutoHeadline(base({ recoveredHeadline: blob }));
  check('rejects an over-long paragraph blob (never truncates it into display)',
    r.accept === false && r.reason === 'too-long', `got len=${blob.length} ${r.reason}`);
}

// --- REJECT: too few words ----------------------------------------------------
{
  const r = evaluateAutoHeadline(base({
    recoveredHeadline: 'Antidisestablishmentarianism hippopotomonstrosesquipedaliophobia pneumonoultramicroscopicsilicovolcanoconiosis',
  }));
  check('rejects a headline with too few words',
    r.accept === false && r.reason === 'too-few-words', `got ${JSON.stringify(r)}`);
}

// --- REJECT: generic / nav / section title ------------------------------------
{
  const r = evaluateAutoHeadline(base({ recoveredHeadline: 'Latest News From Around The World Today' }));
  check('rejects a generic "Latest News…" nav title',
    r.accept === false && r.reason === 'generic', `got ${JSON.stringify(r)}`);
}

// --- REJECT: no meaningful change (case + site-suffix insensitive) ------------
{
  const r = evaluateAutoHeadline(base({
    storedTitle: 'Iran resumes nuclear talks in Geneva',
    recoveredHeadline: 'Iran Resumes Nuclear Talks in Geneva | Reuters',
  }));
  check('rejects when the recovered headline is the same story (case/suffix only)',
    r.accept === false && r.reason === 'no-change', `got ${JSON.stringify(r)}`);
}

// --- REJECT: bot-wall title with a site-name prefix (prod incident 2026-07-14) -
// "Bloomberg - Are you a robot?" passed the old whole-string generic check
// because the junk phrase sits AFTER the site name (suffix-strip only removes
// trailing site names, and 6 words / 28 chars clears the length gates).
{
  const r = evaluateAutoHeadline(base({
    itemUrl: 'https://www.bloomberg.com/news/articles/2026-07-14/india-steel',
    recoveredSourceUrl: 'https://www.bloomberg.com/news/articles/2026-07-14/india-steel',
    recoveredHeadline: 'Bloomberg - Are you a robot?',
  }));
  check('rejects "Bloomberg - Are you a robot?" (bot-wall phrase after site name)',
    r.accept === false && r.reason === 'bot-wall', `got ${JSON.stringify(r)}`);
}
{
  const r = evaluateAutoHeadline(base({
    recoveredHeadline: 'Just a moment... | www.reuters.com checking your browser',
  }));
  check('rejects a Cloudflare "Just a moment…" interstitial title',
    r.accept === false && r.reason === 'bot-wall', `got ${JSON.stringify(r)}`);
}
{
  const r = evaluateAutoHeadline(base({
    recoveredHeadline: 'Access to this page has been denied — reference #4f2a',
  }));
  check('rejects an "access denied" wall title',
    r.accept === false && r.reason === 'bot-wall', `got ${JSON.stringify(r)}`);
}

// --- helper: isBotWallHeadline (also used by the boot heal that deletes bad
// 'auto' override rows already stored in prod) ---------------------------------
{
  check('isBotWallHeadline flags the exact prod headline',
    isBotWallHeadline('Bloomberg - Are you a robot?') === true);
  check('isBotWallHeadline flags "Attention Required! | Cloudflare"',
    isBotWallHeadline('Attention Required! | Cloudflare') === true);
  check('isBotWallHeadline flags a captcha page title',
    isBotWallHeadline('Robot or human? Complete the CAPTCHA to continue') === true);
  check('isBotWallHeadline is whitespace/case tolerant',
    isBotWallHeadline('  ARE  YOU  A  ROBOT?  ') === true);
  check('isBotWallHeadline passes null/empty', isBotWallHeadline(null) === false && isBotWallHeadline('') === false);
  check('isBotWallHeadline passes a real headline',
    isBotWallHeadline('India Wins Bigger Duty-Free Steel Export Quota in UK Trade Deal') === false);
  check('isBotWallHeadline passes a real headline about robots',
    isBotWallHeadline('Ukraine deploys strike drones from sea-based robotic boats') === false);
  check('isBotWallHeadline passes a real headline about denied access',
    isBotWallHeadline('US denies Iran access to frozen assets amid sanctions dispute') === false);
}

// --- REJECT: social posts are never auto-retitled -----------------------------
{
  const r = evaluateAutoHeadline(base({ isSocial: true }));
  check('rejects social posts outright', r.accept === false && r.reason === 'social');
}

// --- REJECT: translate-source outlets (stored title is a deliberate translation)
{
  const r = evaluateAutoHeadline(base({ isTranslateSource: true }));
  check('rejects translate-source outlets outright',
    r.accept === false && r.reason === 'translate-source');
}

// --- helper: sanitize strips HTML tags + entities + control chars -------------
{
  const out = sanitizeRecoveredHeadline("<b>Hello</b> &amp; welcome &#39;world&#39;\u0007");
  check('sanitize strips HTML tags/entities/control chars',
    out === "Hello & welcome 'world'", `got "${out}"`);
}

// --- helper: stripSiteSuffix ---------------------------------------------------
{
  check('stripSiteSuffix removes " - Reuters"',
    stripSiteSuffix('Big story about the economy - Reuters') === 'Big story about the economy');
  check('stripSiteSuffix removes " | The New York Times"',
    stripSiteSuffix('Big story about the economy | The New York Times') === 'Big story about the economy');
  check('stripSiteSuffix does NOT split a hyphenated word (Trump-Biden)',
    stripSiteSuffix('Trump-Biden debate recap and analysis') === 'Trump-Biden debate recap and analysis');
  check('stripSiteSuffix leaves a headline with a colon intact',
    stripSiteSuffix('Report: economy grows 3.5% in the second quarter') === 'Report: economy grows 3.5% in the second quarter');
}

// --- helper: normalizeForCompare ----------------------------------------------
{
  check('normalizeForCompare is case/suffix/trailing-punct insensitive',
    normalizeForCompare('Iran Resumes Talks in Geneva! | Reuters') === normalizeForCompare('iran resumes talks in geneva'));
}

// --- helper: isGenericHeadline ------------------------------------------------
{
  check('isGenericHeadline flags a bare outlet name', isGenericHeadline('Reuters') === true);
  check('isGenericHeadline flags "Breaking News"', isGenericHeadline('Breaking News') === true);
  check('isGenericHeadline flags "Middle East News"', isGenericHeadline('Middle East News') === true);
  check('isGenericHeadline passes a real headline',
    isGenericHeadline('Iran and world powers resume nuclear talks in Geneva') === false);
}

if (failures > 0) {
  console.error(`\n[auto-headline-override] FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\n[auto-headline-override] PASS: all checks passed');
process.exit(0);
