// =============================================================================
// CI gate: social-account catalog contract + projection drift (Task #1038).
//
// WHAT THIS LOCKS
//  shared/socialAccountCatalog.ts is the single source of truth for MCOP's
//  approved social-media roster. Every downstream list (scraper lists, relay
//  single-handle lanes, curated display lists, the curated-only OSINT isolation
//  set, the curated social-intake selector, the general-X account selector, the
//  influencer export, and the Curated UI account groups) is DERIVED from it.
//  Historically these lived as ~8 hand-synced copies that drifted apart. This
//  gate proves:
//
//  A) CONTRACT — the catalog's own invariants hold:
//     1. exactly one lane per account; handles unique (case-insensitive).
//     2. enum fields (lane/visibility/curatedFeed/attachPolicy) are valid and
//        internally consistent (e.g. influencer lane => influencer visibility).
//     3. a legacy DISPLAY alias (INDOPACOM) is inactive for collection but
//        present in the display + isolation projections.
//     4. every registryName resolves to an OUTLET_SEED row whose aliases (or
//        canonicalName) contain the exact scraper handle.
//
//  B) PROJECTION DRIFT — each live consumer's exported list equals the catalog
//     projection, exact-order where order matters (scraping cadence / display).
//     A future edit to a consumer that forgets the catalog fails loudly here.
//
//  C) UI COVERAGE — the Curated U.S. X Feed account-group toggle covers exactly
//     the catalog's us-x + response handles (incl. the INDOPACOM display alias),
//     and the avatar/name maps (client-owned assets) cover every such handle, so
//     no ingested account renders without a toggle/avatar and no dead entry
//     lingers. Avatar/name OWNERSHIP stays in the client; this only checks
//     coverage + the documented sharing (PeteHegseth reuses SecWar).
//
// Pure + offline (static imports + a source-file read for the Curated maps).
// Exit 0 = pass, 1 = fail.
// =============================================================================
import { readFileSync } from 'node:fs';
import {
  SOCIAL_ACCOUNT_CATALOG,
  CATALOG_X_POSTS_ACCOUNTS,
  CATALOG_OSINT_ACCOUNTS,
  CATALOG_JOURNALIST_ACCOUNTS,
  CATALOG_RAPIDRESPONSE_HANDLES,
  CATALOG_DOWRESPONSE_HANDLES,
  CATALOG_SENTDEFENDER_HANDLES,
  CATALOG_INFLUENCER_X_HANDLES,
  CATALOG_CURATED_US_OSINT_ACCOUNTS,
  CATALOG_CURATED_OSINT_ACCOUNTS,
  CATALOG_CURATED_JOURNALIST_ACCOUNTS,
  CATALOG_CURATED_ONLY_OSINT_HANDLES,
  CATALOG_SOCIAL_OSINT_ACCOUNTS,
  CATALOG_GENERAL_X_ACCOUNTS,
  CATALOG_AVATAR_OWNER,
  findSocialAccount,
  findApprovedSocialAccountsForRegistryIdentity,
  type SocialLane,
  type SocialVisibility,
  type CuratedFeed,
  type AttachPolicy,
} from '../shared/socialAccountCatalog';
import { X_POSTS_ACCOUNTS } from '../server/xScraper';
import { OSINT_ACCOUNTS, JOURNALIST_ACCOUNTS } from '../server/osintScraper';
import { INFLUENCER_X_HANDLES } from '../shared/influencerXAccounts';
import { CURATED_ONLY_OSINT_HANDLES } from '../server/curatedOnlyOsint';
import { OUTLET_SEED } from '../server/outletRegistrySeed';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  PASS ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const arr = (a: readonly string[]) => JSON.stringify([...a]);
function eqOrdered(name: string, got: readonly string[], exp: readonly string[]) {
  const ok = arr(got) === arr(exp);
  check(name, ok, ok ? undefined : `\n     got: ${arr(got)}\n     exp: ${arr(exp)}`);
}
function eqSet(name: string, got: readonly string[], exp: readonly string[]) {
  const gs = new Set(got), es = new Set(exp);
  const missing = [...es].filter(x => !gs.has(x));
  const extra = [...gs].filter(x => !es.has(x));
  check(name, missing.length === 0 && extra.length === 0,
    missing.length || extra.length ? `missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}` : undefined);
}

// ---------------------------------------------------------------------------
console.log('\n[A] Catalog contract invariants');
// ---------------------------------------------------------------------------
const LANES: SocialLane[] = ['x-default', 'x-influencer', 'osint', 'journalist', 'rapidresponse', 'dowresponse', 'sentdefender'];
const VIS: SocialVisibility[] = ['main+curated', 'curated-only', 'influencer', 'response'];
const FEEDS: CuratedFeed[] = ['us-x', 'osint-x', 'journalist-x', 'response', null];
const POLICIES: AttachPolicy[] = ['attach-only', 'corroborating', 'release'];

// A1: unique handles (case-insensitive), exactly one lane each.
const seen = new Map<string, number>();
for (const a of SOCIAL_ACCOUNT_CATALOG) {
  const k = a.handle.toLowerCase();
  seen.set(k, (seen.get(k) ?? 0) + 1);
}
const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([h]) => h);
check('A1 handles unique (case-insensitive)', dupes.length === 0, dupes.length ? `dupes=${JSON.stringify(dupes)}` : undefined);
check('A1 every account has exactly one valid lane', SOCIAL_ACCOUNT_CATALOG.every(a => LANES.includes(a.lane)));

// A2: enum validity + cross-field consistency.
check('A2 valid visibility enums', SOCIAL_ACCOUNT_CATALOG.every(a => VIS.includes(a.visibility)));
check('A2 valid curatedFeed enums', SOCIAL_ACCOUNT_CATALOG.every(a => FEEDS.includes(a.curatedFeed)));
check('A2 valid attachPolicy enums', SOCIAL_ACCOUNT_CATALOG.every(a => POLICIES.includes(a.attachPolicy)));
check('A2 influencer lane => influencer visibility + no curated feed',
  SOCIAL_ACCOUNT_CATALOG.filter(a => a.lane === 'x-influencer')
    .every(a => a.visibility === 'influencer' && a.curatedFeed === null));
check('A2 journalist lane => curated-only journalist-x feed',
  SOCIAL_ACCOUNT_CATALOG.filter(a => a.lane === 'journalist')
    .every(a => a.visibility === 'curated-only' && a.curatedFeed === 'journalist-x'));
check('A2 main+curated visibility only on shared osint or x-default',
  SOCIAL_ACCOUNT_CATALOG.filter(a => a.visibility === 'main+curated')
    .every(a => a.lane === 'x-default' || a.lane === 'osint'));

// A3: legacy DISPLAY alias INDOPACOM inactive for collection, active display+iso.
const uspacom = findSocialAccount('USPACOM');
check('A3 INDOPACOM resolves to USPACOM', !!uspacom && uspacom.handle === 'USPACOM');
check('A3 INDOPACOM resolves via findSocialAccount', findSocialAccount('INDOPACOM')?.handle === 'USPACOM');
check('A3 INDOPACOM NOT a collected handle', !CATALOG_OSINT_ACCOUNTS.includes('INDOPACOM'));
check('A3 INDOPACOM present in display list', CATALOG_CURATED_US_OSINT_ACCOUNTS.includes('INDOPACOM'));
check('A3 INDOPACOM present in isolation set', CATALOG_CURATED_ONLY_OSINT_HANDLES.includes('INDOPACOM'));
check('A3 INDOPACOM present in social-intake selector', CATALOG_SOCIAL_OSINT_ACCOUNTS.includes('INDOPACOM'));
check('A3 INDOPACOM avatar owner is USPACOM', CATALOG_AVATAR_OWNER['INDOPACOM'] === 'USPACOM');

// A4: registryName resolves to an OUTLET_SEED row whose aliases/canonicalName
//     contain the exact scraper handle (so name-first findOutlet matches).
const seedByName = new Map(OUTLET_SEED.map(s => [s.canonicalName, s]));
for (const a of SOCIAL_ACCOUNT_CATALOG) {
  if (!a.registryName) continue;
  const row = seedByName.get(a.registryName);
  if (!row) { check(`A4 registry row exists for @${a.handle}`, false, `no OUTLET_SEED row named "${a.registryName}"`); continue; }
  const names = [row.canonicalName, ...(row.aliases ?? [])].map(x => x.toLowerCase());
  check(`A4 @${a.handle} handle in registry aliases/name`, names.includes(a.handle.toLowerCase()),
    `"${a.registryName}" aliases/name do not include @${a.handle}`);
}

// A5: current approved roster stays active; unknown handles activate nothing.
check('A5 AggregateOsint remains in the approved osint lane', CATALOG_OSINT_ACCOUNTS.includes('AggregateOsint'));
check('A5 AggregateOsint resolves to its active catalog entry', findSocialAccount('AggregateOsint')?.lane === 'osint');
check('A5 unknown handle resolves to no active catalog entry', findSocialAccount('not-approved-handle') === null);

// A6: Source Oversight can separate approved social identities from news
//     outlets without treating the registry itself as an approval path.
const enabledRegistryAccounts = SOCIAL_ACCOUNT_CATALOG.filter(
  a => a.enabled && a.visibility !== 'influencer',
);
for (const account of enabledRegistryAccounts) {
  const matchingRows = OUTLET_SEED.filter(row =>
    findApprovedSocialAccountsForRegistryIdentity(row.canonicalName, row.aliases ?? [])
      .some(match => match.handle === account.handle),
  );
  check(`A6 @${account.handle} resolves into the approved-social oversight group`,
    matchingRows.length === 1,
    matchingRows.length !== 1 ? `matched registry rows=${JSON.stringify(matchingRows.map(r => r.canonicalName))}` : undefined);
}
check('A6 unrelated news outlet is not approved by registry presence',
  findApprovedSocialAccountsForRegistryIdentity('Reuters', ['reuters.com']).length === 0);
check('A6 broad descriptive catalog alias cannot classify an unrelated outlet as social',
  findApprovedSocialAccountsForRegistryIdentity('U.S. Central Command').length === 0);

// ---------------------------------------------------------------------------
console.log('\n[B] Projection drift — live consumers equal catalog');
// ---------------------------------------------------------------------------
eqOrdered('B X_POSTS_ACCOUNTS', X_POSTS_ACCOUNTS, CATALOG_X_POSTS_ACCOUNTS);
eqOrdered('B OSINT_ACCOUNTS', OSINT_ACCOUNTS, CATALOG_OSINT_ACCOUNTS);
eqOrdered('B JOURNALIST_ACCOUNTS', JOURNALIST_ACCOUNTS, CATALOG_JOURNALIST_ACCOUNTS);
eqOrdered('B INFLUENCER_X_HANDLES', INFLUENCER_X_HANDLES, CATALOG_INFLUENCER_X_HANDLES);
eqOrdered('B CURATED_ONLY_OSINT_HANDLES', CURATED_ONLY_OSINT_HANDLES, CATALOG_CURATED_ONLY_OSINT_HANDLES);
// Single-handle relay lanes (values are derived directly; assert the catalog projection is a single handle each).
check('B rapidresponse single handle', CATALOG_RAPIDRESPONSE_HANDLES.length === 1 && CATALOG_RAPIDRESPONSE_HANDLES[0] === 'Rapidresponse47');
check('B dowresponse single handle', CATALOG_DOWRESPONSE_HANDLES.length === 1 && CATALOG_DOWRESPONSE_HANDLES[0] === 'DOWResponse');
check('B sentdefender single handle', CATALOG_SENTDEFENDER_HANDLES.length === 1 && CATALOG_SENTDEFENDER_HANDLES[0] === 'sentdefender');

// Consumers that build their list inline from the catalog import (routes.ts /
// curatedIngest.ts): re-derive the exact expected literal here so a change to
// the projection helper that would break those call sites fails loudly.
eqOrdered('B CURATED_US_OSINT_ACCOUNTS shape',
  CATALOG_CURATED_US_OSINT_ACCOUNTS,
  ['CENTCOM','SOUTHCOM','US_EUCOM','USPACOM','INDOPACOM','USAfricaCommand','USNorthernCmd','US_SpaceCom','US_CYBERCOM','USSOCOM','US_STRATCOM','US_TRANSCOM','WhiteHouse']);
eqOrdered('B CURATED_OSINT_ACCOUNTS shape',
  CATALOG_CURATED_OSINT_ACCOUNTS,
  ['MATA_osint','Osint613','Osinttechnical','FirstSquawk','AggregateOsint','pizzintwatch','Global_Mil_Info']);
eqOrdered('B CURATED_JOURNALIST_ACCOUNTS shape',
  CATALOG_CURATED_JOURNALIST_ACCOUNTS,
  ['BarakRavid','jeremybob1','phildstewart','EricSchmittNYT','alexbward']);
eqOrdered('B GENERAL_X_ACCOUNTS shape',
  CATALOG_GENERAL_X_ACCOUNTS,
  ['SecWar','PeteHegseth','SeanParnellASW','DOWResponse','TheJointStaff','SecArmy','SecAFOfficial','SecRubio','StateDept','PressSec','Rapidresponse47','sentdefender']);
eqOrdered('B SOCIAL_OSINT_ACCOUNTS shape',
  CATALOG_SOCIAL_OSINT_ACCOUNTS,
  [...CATALOG_CURATED_US_OSINT_ACCOUNTS, ...CATALOG_CURATED_OSINT_ACCOUNTS]);

// ---------------------------------------------------------------------------
console.log('\n[C] Curated UI coverage — account groups + avatar/name maps');
// ---------------------------------------------------------------------------
const curatedSrc = readFileSync(new URL('../client/src/pages/Curated.tsx', import.meta.url), 'utf8');
const oversightSrc = readFileSync(new URL('../client/src/components/OutletOversightDialog.tsx', import.meta.url), 'utf8');

function extractBlock(src: string, marker: string): string {
  const start = src.indexOf(marker);
  if (start < 0) return '';
  // capture up to the closing "];" (arrays) or "};" (objects) after the marker.
  const tail = src.slice(start);
  const end = tail.search(/\n\][;]|\n\}[;)]/);
  return end < 0 ? tail : tail.slice(0, end + 3);
}

// Handles the U.S. X Feed renders: catalog us-x + response handles + INDOPACOM
// display alias (already covered by CATALOG_CURATED_US_OSINT_ACCOUNTS) + the
// x-default handles + the two response lanes folded into the column.
const usXFeedHandles = new Set<string>();
for (const a of SOCIAL_ACCOUNT_CATALOG) {
  if (a.lane === 'x-default' || a.curatedFeed === 'us-x' || a.curatedFeed === 'response') {
    usXFeedHandles.add(a.handle);
    for (const al of a.displayAliases ?? []) usXFeedHandles.add(al);
  }
}

// C1: account-group block covers exactly usXFeedHandles.
const groupsBlock = extractBlock(curatedSrc, 'US_X_FEED_ACCOUNT_GROUPS');
const groupHandles = new Set<string>();
for (const m of groupsBlock.matchAll(/handles:\s*\[([^\]]*)\]/g)) {
  for (const h of m[1].matchAll(/["']([^"']+)["']/g)) groupHandles.add(h[1]);
}
check('C1 account-group block parsed', groupHandles.size > 0);
// Casing-insensitive coverage (client maps use RapidResponse47 for the
// Rapidresponse47 catalog handle; ownership/casing lives in the client).
const lc = (s: string) => s.toLowerCase();
eqSet('C1 account groups cover exactly the U.S. X Feed handles',
  [...groupHandles].map(lc), [...usXFeedHandles].map(lc));

// C2: avatar + name maps cover every U.S. X Feed handle (client owns assets;
//     we only check coverage). RapidResponse47 uses a distinct casing in the
//     client maps (RapidResponse47) vs the catalog handle (Rapidresponse47);
//     accept either casing for that one account.
function extractKeys(block: string): Set<string> {
  const keys = new Set<string>();
  // match "Key:" at line starts inside the object literal (case-normalized).
  for (const m of block.matchAll(/(?:^|\n)\s*([A-Za-z0-9_]+)\s*:/g)) keys.add(m[1].toLowerCase());
  return keys;
}
// An account may render via a profile image (US_X_FEED_AVATARS /
// RESPONSE_FEED_AVATARS) OR a text-initial fallback (US_X_FEED_INITIALS).
const avatarKeys = new Set<string>([
  ...extractKeys(extractBlock(curatedSrc, 'US_X_FEED_AVATARS')),
  ...extractKeys(extractBlock(curatedSrc, 'RESPONSE_FEED_AVATARS')),
  ...extractKeys(extractBlock(curatedSrc, 'US_X_FEED_INITIALS')),
]);
const nameKeys = extractKeys(extractBlock(curatedSrc, 'US_X_FEED_NAMES'));
const hasKey = (keys: Set<string>, h: string) => keys.has(h.toLowerCase());

// Every U.S. X Feed handle (incl. INDOPACOM display alias) must resolve to an
// avatar/initial and a display name so nothing renders blank.
const avatarGaps = [...usXFeedHandles].filter(h => !hasKey(avatarKeys, h));
const nameGaps = [...usXFeedHandles].filter(h => !hasKey(nameKeys, h));
check('C2 every U.S. X Feed handle has an avatar/initial map entry', avatarGaps.length === 0,
  avatarGaps.length ? `missing avatars: ${JSON.stringify(avatarGaps)}` : undefined);
check('C2 every U.S. X Feed handle has a name map entry', nameGaps.length === 0,
  nameGaps.length ? `missing names: ${JSON.stringify(nameGaps)}` : undefined);

// C3: documented avatar/name SHARING (ownership stays in client). PeteHegseth
//     reuses SecWar's asset; INDOPACOM reuses USPACOM's. Assert the catalog
//     records this so the drift test and the client stay in agreement.
check('C3 PeteHegseth avatar owner is SecWar', CATALOG_AVATAR_OWNER['PeteHegseth'] === 'SecWar');
check('C3 INDOPACOM avatar owner is USPACOM', CATALOG_AVATAR_OWNER['INDOPACOM'] === 'USPACOM');

// C4: Source Oversight visibly keeps catalog-approved social identities in one
//     section separate from regular news outlets.
check('C4 Source Oversight renders a news-outlet section',
  oversightSrc.includes('data-testid="section-registry-news"'));
check('C4 Source Oversight renders an approved-social section',
  oversightSrc.includes('data-testid="section-registry-social"')
  && oversightSrc.includes('Approved social accounts'));

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} social-account-catalog-drift (${failures} failure${failures === 1 ? '' : 's'})`);
process.exit(failures === 0 ? 0 : 1);
