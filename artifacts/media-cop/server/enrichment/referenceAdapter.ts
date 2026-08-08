// =============================================================================
// Reference-dataset adapter — the one public-reference adapter wired by default.
//
// Matches an outlet against the bundled REFERENCE_DATASET, preferring a domain
// match (high confidence) and falling back to canonical-name / alias matching
// (lower confidence). Returns null when the dataset has no entry, which leaves
// the outlet unconfirmed (attach-only).
// =============================================================================
import { normalizeOutletName, extractOutletDomain } from "@shared/outletRegistry";
import type {
  OutletEnrichmentAdapter,
  OutletEnrichmentInput,
  OutletEnrichmentResult,
  OutletEnrichmentFields,
} from "./types";
import { REFERENCE_DATASET, type ReferenceEntry } from "./referenceDataset";

// Build O(1) lookup maps once at module load.
const byDomain = new Map<string, ReferenceEntry>();
const byName = new Map<string, ReferenceEntry>();
for (const entry of REFERENCE_DATASET) {
  for (const d of entry.domains) {
    const dom = extractOutletDomain(d) || d.toLowerCase().trim();
    if (dom && !byDomain.has(dom)) byDomain.set(dom, entry);
  }
  for (const n of entry.names ?? []) {
    const k = normalizeOutletName(n);
    if (k && !byName.has(k)) byName.set(k, entry);
  }
}

function toFields(entry: ReferenceEntry): OutletEnrichmentFields {
  const { domains: _d, names: _n, ...fields } = entry;
  return fields;
}

/**
 * Returns true if the given outlet would match at least one entry in the
 * bundled reference dataset (either by domain or by name). Used by the
 * coverage endpoint to distinguish "enrichment overdue" from "no reference
 * data available for this outlet".
 */
export function wouldMatch(input: Pick<OutletEnrichmentInput, "domains" | "canonicalName" | "aliases">): boolean {
  for (const raw of input.domains) {
    const dom = extractOutletDomain(raw) || raw.toLowerCase().trim();
    let d = dom;
    while (d && d.includes(".")) {
      if (byDomain.has(d)) return true;
      d = d.slice(d.indexOf(".") + 1);
    }
  }
  const candidates = [input.canonicalName, ...(input.aliases ?? [])];
  for (const c of candidates) {
    const k = normalizeOutletName(c);
    if (k && byName.has(k)) return true;
  }
  return false;
}

export class ReferenceDatasetAdapter implements OutletEnrichmentAdapter {
  readonly name = "public-reference";

  async enrich(input: OutletEnrichmentInput): Promise<OutletEnrichmentResult | null> {
    // 1) Domain match (most reliable), progressively stripping subdomains.
    for (const raw of input.domains) {
      const dom = extractOutletDomain(raw) || raw.toLowerCase().trim();
      let d = dom;
      while (d && d.includes(".")) {
        const hit = byDomain.get(d);
        if (hit) {
          return { fields: toFields(hit), confidence: 0.95, matchedOn: `domain:${d}` };
        }
        d = d.slice(d.indexOf(".") + 1);
      }
    }

    // 2) Name / alias fallback.
    const candidates = [input.canonicalName, ...input.aliases];
    for (const c of candidates) {
      const k = normalizeOutletName(c);
      const hit = k ? byName.get(k) : undefined;
      if (hit) {
        return { fields: toFields(hit), confidence: 0.7, matchedOn: `name:${k}` };
      }
    }

    return null;
  }
}
