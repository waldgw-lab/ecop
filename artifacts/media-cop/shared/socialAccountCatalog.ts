// =============================================================================
// Canonical social-account catalog (Task #1038).
//
// SINGLE SOURCE OF TRUTH for MCOP's approved social-media roster. Every scraper
// list, relay handle→lane registry, curated ingest selector, curated display
// list, curated-only OSINT isolation set, general-X account selector, influencer
// export, and Curated UI account group is DERIVED from the entries below (see the
// projection helpers at the bottom). Adding, removing, or re-classifying an
// account is a one-line edit here that fans out to every consumer, instead of a
// hand-synced edit across ~8 files that historically drifted apart.
//
// WHAT THIS ENCODES (per account):
//   - handle          exact scraper/relay handle (spelling matters; lookups are
//                     case-insensitive and tolerate a leading '@').
//   - enabled         approved + wired into MCOP right now (current roster only).
//   - collect         does MCOP actively COLLECT this handle (scraper list /
//                     relay lane accepts it)? A legacy alias has collect:false
//                     but stays enabled for DISPLAY + ISOLATION.
//   - lane            exactly ONE ingestion lane (the table/scraper it feeds).
//   - visibility      where it surfaces: 'main+curated' | 'curated-only' |
//                     'influencer' | 'response'.
//   - curatedFeed     which curated column it is placed in (null if none).
//   - registryName    canonicalName of its Outlet Registry row (for name-first
//                     resolution); null for lanes with no registry row.
//   - attachPolicy    'attach-only' | 'corroborating' | 'release' — descriptive
//                     registry identity intent. Runtime Curated behavior is
//                     derived from the Outlet Registry, not this field. Ordinary
//                     official social is attach-only; command accounts explicitly
//                     registered as releases retain release intent.
//   - aliases         legacy handles that must still resolve/display/isolate to
//                     this account even though they are no longer collected.
//   - avatarOwner     the handle that OWNS the avatar/name asset for this account
//                     (self by default; PeteHegseth reuses SecWar's, legacy
//                     aliases reuse their canonical handle's). The client keeps
//                     ownership of the actual imported asset — this only records
//                     WHICH handle's asset to reuse so drift tests can check it.
//
// LEGACY ALIAS RULE (INDOPACOM): @USPACOM was formerly @INDOPACOM. The alias is
//   INACTIVE for COLLECTION (never scraped/relayed) but ACTIVE for DISPLAY
//   (avatar/name/account-group) and ISOLATION (curated-only exclusion), so
//   already-stored posts under the old name still surface correctly and never
//   leak into non-curated readers.
//
// =============================================================================

export type SocialLane =
  | 'x-default'
  | 'x-influencer'
  | 'osint'
  | 'journalist'
  | 'rapidresponse'
  | 'dowresponse'
  | 'sentdefender';

export type SocialVisibility =
  | 'main+curated'   // main MCOP feed AND Curated
  | 'curated-only'   // Curated / select surfaces only (isolated from main readers)
  | 'influencer'     // influencer feed only
  | 'response';      // curated response columns (rapid/dow response)

export type CuratedFeed =
  | 'us-x'           // Curated "U.S. X Feed"
  | 'osint-x'        // Curated "OSINT X Feed"
  | 'journalist-x'   // Curated isolated "Journalists X Feed"
  | 'response'       // folded into the U.S. X Feed as a response column
  | null;

export type AttachPolicy = 'attach-only' | 'corroborating' | 'release';

export interface SocialAccount {
  /** Exact scraper/relay handle. */
  handle: string;
  /** Approved + wired into MCOP right now (current roster only). */
  enabled: boolean;
  /** Does MCOP actively COLLECT this handle (scraper list / relay lane)? */
  collect: boolean;
  /** Exactly one ingestion lane. */
  lane: SocialLane;
  /** Where the account surfaces. */
  visibility: SocialVisibility;
  /** Which curated column it is placed in (null if none / not curated). */
  curatedFeed: CuratedFeed;
  /** canonicalName of the Outlet Registry row (null if the lane has none). */
  registryName: string | null;
  /** Registry role/identity intent. */
  attachPolicy: AttachPolicy;
  /**
   * Registry aliases — human-readable/legacy names that findOutlet() must match
   * (e.g. "U.S. Central Command", "EUCOM"). These are NOT collected handles and
   * are NOT added to display/isolation lists.
   */
  aliases: readonly string[];
  /**
   * Legacy HANDLE aliases that are INACTIVE for collection but ACTIVE for
   * display + isolation (e.g. INDOPACOM → USPACOM). Already-stored posts under
   * the old handle must still surface in Curated and stay excluded from
   * non-curated readers.
   */
  displayAliases?: readonly string[];
  /** Handle that owns the avatar/name asset (defaults to self). */
  avatarOwner?: string;
}

// ---------------------------------------------------------------------------
// THE ROSTER (current, approved accounts only).
// ---------------------------------------------------------------------------
export const SOCIAL_ACCOUNT_CATALOG: readonly SocialAccount[] = [
  // --- x-default (X_POSTS_ACCOUNTS → x_posts, category 'default'): main U.S. X
  //     feed AND Curated. ---------------------------------------------------
  { handle: 'SecWar', enabled: true, collect: true, lane: 'x-default', visibility: 'main+curated', curatedFeed: 'us-x', registryName: 'SecWar / Pete Hegseth (X)', attachPolicy: 'attach-only', aliases: [] },
  // Pete Hegseth's personal account is the same person as @SecWar and reuses its
  // avatar/name asset; independently toggleable in the Curated header.
  { handle: 'PeteHegseth', enabled: true, collect: true, lane: 'x-default', visibility: 'main+curated', curatedFeed: 'us-x', registryName: 'SecWar / Pete Hegseth (X)', attachPolicy: 'attach-only', aliases: [], avatarOwner: 'SecWar' },
  { handle: 'SeanParnellASW', enabled: true, collect: true, lane: 'x-default', visibility: 'main+curated', curatedFeed: 'us-x', registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'TheJointStaff', enabled: true, collect: true, lane: 'x-default', visibility: 'main+curated', curatedFeed: 'us-x', registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'SecArmy', enabled: true, collect: true, lane: 'x-default', visibility: 'main+curated', curatedFeed: 'us-x', registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'SecAFOfficial', enabled: true, collect: true, lane: 'x-default', visibility: 'main+curated', curatedFeed: 'us-x', registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'SecRubio', enabled: true, collect: true, lane: 'x-default', visibility: 'main+curated', curatedFeed: 'us-x', registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'StateDept', enabled: true, collect: true, lane: 'x-default', visibility: 'main+curated', curatedFeed: 'us-x', registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'PressSec', enabled: true, collect: true, lane: 'x-default', visibility: 'main+curated', curatedFeed: 'us-x', registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'DoWCIODavies', enabled: true, collect: true, lane: 'x-default', visibility: 'main+curated', curatedFeed: 'us-x', registryName: 'DoW CIO Kirsten Davies', attachPolicy: 'attach-only', aliases: [] },

  // --- osint (OSINT_ACCOUNTS → osint_posts). Entry order matches the scraper
  //     list (OSINT_ACCOUNTS) exactly. CENTCOM/SOUTHCOM are SHARED (main OSINT
  //     feed + Curated); the other commands + WhiteHouse are curated-only
  //     (read-time excluded from non-curated readers); the analysts render in
  //     the curated OSINT X Feed. --------------------------------------------
  { handle: 'MATA_osint', enabled: true, collect: true, lane: 'osint', visibility: 'curated-only', curatedFeed: 'osint-x', registryName: 'MATA_osint', attachPolicy: 'attach-only', aliases: [] },
  { handle: 'CENTCOM', enabled: true, collect: true, lane: 'osint', visibility: 'main+curated', curatedFeed: 'us-x', registryName: 'CENTCOM', attachPolicy: 'release', aliases: ['U.S. Central Command'] },
  { handle: 'SOUTHCOM', enabled: true, collect: true, lane: 'osint', visibility: 'main+curated', curatedFeed: 'us-x', registryName: 'SOUTHCOM', attachPolicy: 'release', aliases: ['U.S. Southern Command'] },
  { handle: 'Osint613', enabled: true, collect: true, lane: 'osint', visibility: 'curated-only', curatedFeed: 'osint-x', registryName: 'Osint613', attachPolicy: 'attach-only', aliases: [] },
  { handle: 'Osinttechnical', enabled: true, collect: true, lane: 'osint', visibility: 'curated-only', curatedFeed: 'osint-x', registryName: 'Osinttechnical', attachPolicy: 'attach-only', aliases: [] },
  { handle: 'FirstSquawk', enabled: true, collect: true, lane: 'osint', visibility: 'curated-only', curatedFeed: 'osint-x', registryName: 'FirstSquawk', attachPolicy: 'attach-only', aliases: [] },
  { handle: 'AggregateOsint', enabled: true, collect: true, lane: 'osint', visibility: 'curated-only', curatedFeed: 'osint-x', registryName: 'AggregateOsint', attachPolicy: 'attach-only', aliases: [] },
  { handle: 'pizzintwatch', enabled: true, collect: true, lane: 'osint', visibility: 'curated-only', curatedFeed: 'osint-x', registryName: 'pizzintwatch', attachPolicy: 'attach-only', aliases: [] },
  { handle: 'Global_Mil_Info', enabled: true, collect: true, lane: 'osint', visibility: 'curated-only', curatedFeed: 'osint-x', registryName: 'Global_Mil_Info', attachPolicy: 'attach-only', aliases: [] },
  { handle: 'US_EUCOM', enabled: true, collect: true, lane: 'osint', visibility: 'curated-only', curatedFeed: 'us-x', registryName: 'U.S. European Command', attachPolicy: 'release', aliases: ['EUCOM'] },
  // @USPACOM (formerly @INDOPACOM). The INDOPACOM handle alias is INACTIVE for
  // collection (not scraped/relayed) but ACTIVE for display + isolation.
  { handle: 'USPACOM', enabled: true, collect: true, lane: 'osint', visibility: 'curated-only', curatedFeed: 'us-x', registryName: 'U.S. Indo-Pacific Command', attachPolicy: 'release', aliases: ['U.S. Pacific Command'], displayAliases: ['INDOPACOM'] },
  { handle: 'USAfricaCommand', enabled: true, collect: true, lane: 'osint', visibility: 'curated-only', curatedFeed: 'us-x', registryName: 'U.S. Africa Command (AFRICOM)', attachPolicy: 'release', aliases: ['AFRICOM', 'U.S. Africa Command'] },
  { handle: 'USNorthernCmd', enabled: true, collect: true, lane: 'osint', visibility: 'curated-only', curatedFeed: 'us-x', registryName: null, attachPolicy: 'release', aliases: [] },
  { handle: 'US_SpaceCom', enabled: true, collect: true, lane: 'osint', visibility: 'curated-only', curatedFeed: 'us-x', registryName: null, attachPolicy: 'release', aliases: [] },
  { handle: 'US_CYBERCOM', enabled: true, collect: true, lane: 'osint', visibility: 'curated-only', curatedFeed: 'us-x', registryName: null, attachPolicy: 'release', aliases: [] },
  { handle: 'USSOCOM', enabled: true, collect: true, lane: 'osint', visibility: 'curated-only', curatedFeed: 'us-x', registryName: null, attachPolicy: 'release', aliases: [] },
  { handle: 'US_STRATCOM', enabled: true, collect: true, lane: 'osint', visibility: 'curated-only', curatedFeed: 'us-x', registryName: null, attachPolicy: 'release', aliases: [] },
  { handle: 'US_TRANSCOM', enabled: true, collect: true, lane: 'osint', visibility: 'curated-only', curatedFeed: 'us-x', registryName: null, attachPolicy: 'release', aliases: [] },
  { handle: 'WhiteHouse', enabled: true, collect: true, lane: 'osint', visibility: 'curated-only', curatedFeed: 'us-x', registryName: null, attachPolicy: 'attach-only', aliases: [] },

  // --- journalist (JOURNALIST_ACCOUNTS → journalist_posts): isolated,
  //     curated-only "Journalists X Feed". ---------------------------------
  { handle: 'BarakRavid', enabled: true, collect: true, lane: 'journalist', visibility: 'curated-only', curatedFeed: 'journalist-x', registryName: 'BarakRavid', attachPolicy: 'attach-only', aliases: [] },
  { handle: 'jeremybob1', enabled: true, collect: true, lane: 'journalist', visibility: 'curated-only', curatedFeed: 'journalist-x', registryName: 'jeremybob1', attachPolicy: 'attach-only', aliases: [] },
  { handle: 'phildstewart', enabled: true, collect: true, lane: 'journalist', visibility: 'curated-only', curatedFeed: 'journalist-x', registryName: 'phildstewart', attachPolicy: 'attach-only', aliases: [] },
  { handle: 'EricSchmittNYT', enabled: true, collect: true, lane: 'journalist', visibility: 'curated-only', curatedFeed: 'journalist-x', registryName: 'EricSchmittNYT', attachPolicy: 'attach-only', aliases: [] },
  { handle: 'alexbward', enabled: true, collect: true, lane: 'journalist', visibility: 'curated-only', curatedFeed: 'journalist-x', registryName: 'alexbward', attachPolicy: 'attach-only', aliases: [] },

  // --- Dedicated single-handle lanes (own scrapers/tables). --------------
  { handle: 'Rapidresponse47', enabled: true, collect: true, lane: 'rapidresponse', visibility: 'response', curatedFeed: 'response', registryName: 'RapidResponse47', attachPolicy: 'attach-only', aliases: ['RapidResponse47'] },
  { handle: 'DOWResponse', enabled: true, collect: true, lane: 'dowresponse', visibility: 'response', curatedFeed: 'response', registryName: 'DOWResponse', attachPolicy: 'attach-only', aliases: [] },
  { handle: 'sentdefender', enabled: true, collect: true, lane: 'sentdefender', visibility: 'curated-only', curatedFeed: 'osint-x', registryName: 'sentdefender', attachPolicy: 'attach-only', aliases: ['OSINTdefender'] },

  // --- x-influencer (INFLUENCER_X_ACCOUNTS → x_posts, category 'influencer'):
  //     influencer feed only. -----------------------------------------------
  { handle: 'AndrewKolvet', enabled: true, collect: true, lane: 'x-influencer', visibility: 'influencer', curatedFeed: null, registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'libsoftiktok', enabled: true, collect: true, lane: 'x-influencer', visibility: 'influencer', curatedFeed: null, registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'JackPosobiec', enabled: true, collect: true, lane: 'x-influencer', visibility: 'influencer', curatedFeed: null, registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'EndWokeness', enabled: true, collect: true, lane: 'x-influencer', visibility: 'influencer', curatedFeed: null, registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'WallStreetMav', enabled: true, collect: true, lane: 'x-influencer', visibility: 'influencer', curatedFeed: null, registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'MeghanMcCain', enabled: true, collect: true, lane: 'x-influencer', visibility: 'influencer', curatedFeed: null, registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'TaraBull', enabled: true, collect: true, lane: 'x-influencer', visibility: 'influencer', curatedFeed: null, registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'GrageDustin', enabled: true, collect: true, lane: 'x-influencer', visibility: 'influencer', curatedFeed: null, registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'Cernovich', enabled: true, collect: true, lane: 'x-influencer', visibility: 'influencer', curatedFeed: null, registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'TomFitton', enabled: true, collect: true, lane: 'x-influencer', visibility: 'influencer', curatedFeed: null, registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'Geiger_Capital', enabled: true, collect: true, lane: 'x-influencer', visibility: 'influencer', curatedFeed: null, registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'BuzzPatterson', enabled: true, collect: true, lane: 'x-influencer', visibility: 'influencer', curatedFeed: null, registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'Shawn_Farash', enabled: true, collect: true, lane: 'x-influencer', visibility: 'influencer', curatedFeed: null, registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'NickAdamsinUSA', enabled: true, collect: true, lane: 'x-influencer', visibility: 'influencer', curatedFeed: null, registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'VoteRandyFine', enabled: true, collect: true, lane: 'x-influencer', visibility: 'influencer', curatedFeed: null, registryName: null, attachPolicy: 'attach-only', aliases: [] },
  { handle: 'BrilynHollyhand', enabled: true, collect: true, lane: 'x-influencer', visibility: 'influencer', curatedFeed: null, registryName: null, attachPolicy: 'attach-only', aliases: [] },
] as const;

// ---------------------------------------------------------------------------
// Derivation helpers (projections). Each downstream list is produced from the
// catalog so it can never silently drift.
// ---------------------------------------------------------------------------

/** Enabled + actively-collected accounts in a lane (drops legacy aliases). */
function collectedInLane(lane: SocialLane): SocialAccount[] {
  return SOCIAL_ACCOUNT_CATALOG.filter(a => a.enabled && a.collect && a.lane === lane);
}

/** x-default scraper list (server/xScraper.ts X_POSTS_ACCOUNTS). */
export const CATALOG_X_POSTS_ACCOUNTS: readonly string[] =
  collectedInLane('x-default').map(a => a.handle);

/** osint scraper list (server/osintScraper.ts OSINT_ACCOUNTS). */
export const CATALOG_OSINT_ACCOUNTS: readonly string[] =
  collectedInLane('osint').map(a => a.handle);

/** journalist scraper list (server/osintScraper.ts JOURNALIST_ACCOUNTS). */
export const CATALOG_JOURNALIST_ACCOUNTS: readonly string[] =
  collectedInLane('journalist').map(a => a.handle);

/** Dedicated single-handle lanes (server/xRelayService.ts). */
export const CATALOG_RAPIDRESPONSE_HANDLES: readonly string[] =
  collectedInLane('rapidresponse').map(a => a.handle);
export const CATALOG_DOWRESPONSE_HANDLES: readonly string[] =
  collectedInLane('dowresponse').map(a => a.handle);
export const CATALOG_SENTDEFENDER_HANDLES: readonly string[] =
  collectedInLane('sentdefender').map(a => a.handle);

/** Every enabled, actively-collected, non-influencer account eligible for Curated attachment intake. */
export const CATALOG_CURATED_ATTACHMENT_ACCOUNTS: readonly SocialAccount[] =
  SOCIAL_ACCOUNT_CATALOG.filter(a =>
    a.enabled &&
    a.collect &&
    a.lane !== 'x-influencer' &&
    a.curatedFeed !== null
  );

/** Fail-closed approval check used at Curated social admission and picker boundaries. */
export function isApprovedCuratedAttachmentAccount(
  handle: string | null | undefined,
  lane?: SocialLane,
): boolean {
  const account = findSocialAccount(handle);
  return !!account &&
    account.enabled &&
    account.collect &&
    account.lane !== 'x-influencer' &&
    account.curatedFeed !== null &&
    (!lane || account.lane === lane);
}

/** Influencer accounts/handles (shared/influencerXAccounts.ts). */
export const CATALOG_INFLUENCER_X_HANDLES: readonly string[] =
  collectedInLane('x-influencer').map(a => a.handle);

/**
 * Curated "U.S. X Feed" OSINT-lane handles (server/routes.ts
 * CURATED_US_OSINT_ACCOUNTS). Includes legacy display aliases (e.g. INDOPACOM)
 * so already-stored posts under the old name still surface. Order preserves the
 * combatant-command grouping used today.
 */
export const CATALOG_CURATED_US_OSINT_ACCOUNTS: readonly string[] = (() => {
  const out: string[] = [];
  for (const a of SOCIAL_ACCOUNT_CATALOG) {
    if (!a.enabled || a.lane !== 'osint' || a.curatedFeed !== 'us-x') continue;
    out.push(a.handle);
    // Legacy display-handle aliases are display-active (inactive for collection).
    for (const alias of a.displayAliases ?? []) {
      if (!out.includes(alias)) out.push(alias);
    }
  }
  return out;
})();

/**
 * Curated "OSINT X Feed" OSINT-lane analyst handles (server/routes.ts
 * CURATED_OSINT_ACCOUNTS). sentdefender is prepended separately by the route.
 */
export const CATALOG_CURATED_OSINT_ACCOUNTS: readonly string[] =
  SOCIAL_ACCOUNT_CATALOG
    .filter(a => a.enabled && a.lane === 'osint' && a.curatedFeed === 'osint-x')
    .map(a => a.handle);

/** Curated "Journalists X Feed" (server/routes.ts CURATED_JOURNALIST_ACCOUNTS). */
export const CATALOG_CURATED_JOURNALIST_ACCOUNTS: readonly string[] =
  SOCIAL_ACCOUNT_CATALOG
    .filter(a => a.enabled && a.lane === 'journalist' && a.curatedFeed === 'journalist-x')
    .map(a => a.handle);

/**
 * Curated-only OSINT isolation set (server/curatedOnlyOsint.ts
 * CURATED_ONLY_OSINT_HANDLES). Every osint-lane account whose visibility is
 * curated-only, INCLUDING its legacy handle aliases (so old-name posts never
 * leak into non-curated readers). CENTCOM/SOUTHCOM are excluded (shared). The
 * OSINT-analyst handles are NOT in this set (they were never shared to the main
 * OSINT feed via this mechanism — they live in the OSINT X Feed only and were
 * historically not listed here).
 */
export const CATALOG_CURATED_ONLY_OSINT_HANDLES: readonly string[] = (() => {
  const out: string[] = [];
  for (const a of SOCIAL_ACCOUNT_CATALOG) {
    if (!a.enabled || a.lane !== 'osint') continue;
    if (a.visibility !== 'curated-only') continue;
    if (a.curatedFeed !== 'us-x') continue; // commands + WhiteHouse only
    out.push(a.handle);
    for (const alias of a.displayAliases ?? []) {
      if (!out.includes(alias)) out.push(alias);
    }
  }
  return out;
})();

/**
 * Curated social-intake OSINT selector (server/curatedIngest.ts
 * SOCIAL_OSINT_ACCOUNTS). Commands + WhiteHouse (us-x) followed by the analyst
 * handles (osint-x), matching today's ordering. Includes legacy display aliases
 * for the us-x commands.
 */
export const CATALOG_SOCIAL_OSINT_ACCOUNTS: readonly string[] = [
  ...CATALOG_CURATED_US_OSINT_ACCOUNTS,
  ...CATALOG_CURATED_OSINT_ACCOUNTS,
];

/**
 * "General X" (all X-account) selector used by the per-MCOP feed builder
 * (server/routes.ts ALL_X_ACCOUNTS). This is the set of X handles a custom MCOP
 * viewer can hide: the x-default handles plus the three dedicated response/OSINT
 * single-handle lanes that render in that feed. Order matches today's list.
 */
export const CATALOG_GENERAL_X_ACCOUNTS: readonly string[] = (() => {
  const xDefault = collectedInLane('x-default')
    .map(a => a.handle)
    .filter(h => h !== 'DoWCIODavies'); // preserve historical omission
  // Insert @DOWResponse after @SeanParnellASW, then append the two remaining
  // single-handle response/OSINT lanes — matching today's ALL_X_ACCOUNTS order.
  const out: string[] = [];
  for (const h of xDefault) {
    out.push(h);
    if (h === 'SeanParnellASW') out.push('DOWResponse');
  }
  out.push('Rapidresponse47', 'sentdefender');
  return out;
})();

/**
 * Avatar/name ownership map: handle → the handle whose avatar/name asset it
 * reuses. The client OWNS the actual imported asset; this only records the
 * intended sharing so a drift test can verify the client's maps agree.
 */
export const CATALOG_AVATAR_OWNER: Readonly<Record<string, string>> = (() => {
  const m: Record<string, string> = {};
  for (const a of SOCIAL_ACCOUNT_CATALOG) {
    m[a.handle] = a.avatarOwner ?? a.handle;
    for (const alias of a.displayAliases ?? []) {
      m[alias] = a.avatarOwner ?? a.handle;
    }
  }
  return m;
})();

/** Lookup by handle (case-insensitive, tolerant of a leading '@'). */
export function findSocialAccount(handle: string | null | undefined): SocialAccount | null {
  if (!handle) return null;
  const key = handle.trim().replace(/^@+/, '').toLowerCase();
  for (const a of SOCIAL_ACCOUNT_CATALOG) {
    if (a.handle.toLowerCase() === key) return a;
    if (a.aliases.some(al => al.toLowerCase() === key)) return a;
    if ((a.displayAliases ?? []).some(al => al.toLowerCase() === key)) return a;
  }
  return null;
}

/**
 * Resolve an Outlet Registry identity to its enabled catalog accounts.
 *
 * Registry enrichment remains separately owned, so this intentionally matches
 * only explicit social identities: the catalog registryName, canonical handle,
 * and legacy display-handle aliases. Descriptive catalog aliases are lookup
 * aids for findSocialAccount() and must never classify an unrelated registry
 * row as an approved social account. This is a presentation and oversight
 * projection — never an alternate collection-approval path.
 */
export function findApprovedSocialAccountsForRegistryIdentity(
  canonicalName: string,
  registryAliases: readonly string[] = [],
): SocialAccount[] {
  const normalize = (value: string) => value.trim().replace(/^@+/, '').toLowerCase();
  const canonicalKey = normalize(canonicalName);
  const identityKeys = new Set([canonicalName, ...registryAliases].map(normalize));

  return SOCIAL_ACCOUNT_CATALOG.filter((account) => {
    if (!account.enabled) return false;
    if (account.registryName && normalize(account.registryName) === canonicalKey) return true;
    return [
      account.handle,
      ...(account.displayAliases ?? []),
    ].some((identity) => identityKeys.has(normalize(identity)));
  });
}
