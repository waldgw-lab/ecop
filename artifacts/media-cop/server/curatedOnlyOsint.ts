// Combatant-command X accounts (Task #282 follow-up) that are CURATED-ONLY.
//
// These handles are scraped into the SHARED osint_posts table via OSINT_ACCOUNTS
// (server/osintScraper.ts), but must only ever appear in the Curated U.S. X Feed
// (/api/curated/x-posts). Every NON-curated reader of osint_posts excludes them:
//   - main OSINT feed (/api/osint-posts) + Dashboard/Stream consumers
//   - combined X feed (/api/x-feed/all)
//   - public API (/api/v1/social and its status counts)
//   - MCOP Bot archive (search, source counts, getFullText)
//
// The curated reader (storage.getCuratedOsintPosts) does NOT filter this list, so
// the Curated U.S. X Feed still shows them. This gives the same "isolated,
// curated-only" guarantee as the journalist lane without a separate table.
//
// CENTCOM and SOUTHCOM are intentionally NOT in this list — they remain shared
// (visible in both the main OSINT feed and Curated), matching their long-standing
// behavior. Keep this list in sync with the combatant-command entries added to
// OSINT_ACCOUNTS (server/osintScraper.ts) and CURATED_US_OSINT_ACCOUNTS
// (server/routes.ts).
// Derived from the canonical social-account catalog (Task #1038): every
// osint-lane account whose visibility is curated-only and whose curated feed is
// the U.S. X Feed (commands + @WhiteHouse), PLUS their legacy display-handle
// aliases (e.g. @INDOPACOM) so already-stored posts under the old name never
// leak into the non-curated OSINT/public readers. CENTCOM/SOUTHCOM are excluded
// (shared). Edit the roster in shared/socialAccountCatalog.ts.
import { CATALOG_CURATED_ONLY_OSINT_HANDLES } from "@shared/socialAccountCatalog";

export const CURATED_ONLY_OSINT_HANDLES: readonly string[] = CATALOG_CURATED_ONLY_OSINT_HANDLES;

export const CURATED_ONLY_OSINT_HANDLE_SET: ReadonlySet<string> = new Set(
  CURATED_ONLY_OSINT_HANDLES,
);
