// Pure helpers for the Task #927 curated classification overlay URL-identity
// merge. Extracted so the conflict-resolution rules can be unit-tested without a
// database. CURATED-LANE only: this only ever reasons about curated_classifications
// rows keyed by the shared canonical identity URL (normalizeIdentityUrl).

import { normalizeIdentityUrl } from './urlIdentity';

export interface OverlayMergeRow {
  url: string;
  primary_topic?: string | null;
  provenance?: string | null;
  classified_at?: Date | string | number | null;
}

// Group overlay rows by their canonical identity URL. Rows whose URL normalizes
// to an empty string (degenerate input) are dropped.
export function groupOverlayRowsByCanonical<T extends OverlayMergeRow>(
  rows: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const canonical = normalizeIdentityUrl(r.url);
    if (!canonical) continue;
    const list = groups.get(canonical) ?? [];
    list.push(r);
    groups.set(canonical, list);
  }
  return groups;
}

// Conflict resolution when several raw-URL rows collapse to one canonical key:
//   1. a provenance='human' row always wins (protected editor override),
//   2. otherwise prefer a row with a non-null primary_topic (a real label),
//   3. otherwise the most recently classified row.
// Deterministic and total: given a non-empty group it always returns one row.
export function pickOverlaySurvivor<T extends OverlayMergeRow>(list: T[]): T {
  const rank = (r: OverlayMergeRow) =>
    (r.provenance === 'human' ? 2 : 0) + (r.primary_topic != null ? 1 : 0);
  const ts = (r: OverlayMergeRow) =>
    r.classified_at ? new Date(r.classified_at).getTime() : 0;
  let survivor = list[0];
  for (const r of list) {
    const d = rank(r) - rank(survivor);
    if (d > 0) {
      survivor = r;
    } else if (d === 0 && ts(r) > ts(survivor)) {
      survivor = r;
    }
  }
  return survivor;
}
