// =============================================================================
// Outlet enrichment — pluggable adapter contract.
//
// An "adapter" maps an outlet (its canonical name / aliases / domains) to a set
// of reference-derived descriptive fields: origin country / region and
// factuality. Adapters are intentionally
// dumb knowledge lookups — they never write to the DB and never decide what
// enters a feed. The enrichment service (./index) calls them, picks a result,
// and persists ONLY to the outlet_registry labeling layer.
//
// Adding a new reference (e.g. a licensed Ground News / Ad Fontes feed) is just
// a new module implementing OutletEnrichmentAdapter, registered in ./index.
// =============================================================================

export interface OutletEnrichmentInput {
  /** Normalized canonical key (see normalizeOutletName). */
  key: string;
  canonicalName: string;
  aliases: string[];
  domains: string[];
}

// The descriptive fields an adapter may fill. All optional — an adapter returns
// only what its reference actually knows. Field names match outlet_registry
// columns 1:1 so the service can write them generically.
export interface OutletEnrichmentFields {
  originCountry?: string;
  originRegion?: string;
  factuality?: string;
}

export interface OutletEnrichmentResult {
  fields: OutletEnrichmentFields;
  /** 0..1 — how confident this adapter is in the match. */
  confidence: number;
  /** Human-readable note on how the match was made, e.g. "domain:apnews.com". */
  matchedOn: string;
}

export interface OutletEnrichmentAdapter {
  readonly name: string;
  /**
   * Resolve descriptive fields for an outlet, or null when the reference has no
   * data for it (which leaves the outlet unconfirmed → attach-only).
   */
  enrich(input: OutletEnrichmentInput): Promise<OutletEnrichmentResult | null>;
}
