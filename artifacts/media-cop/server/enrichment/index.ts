// =============================================================================
// Outlet enrichment service.
//
// Runs OFF the ingest hot path: a delayed initial pass at boot plus a batched
// overnight refresh (see scheduler). Iterates outlet_registry rows, asks each
// registered adapter for reference data, and writes ONLY descriptive fields back
// to the registry — never role (no auto-promotion), never a feed.
//
// Resource discipline (FD-hygiene rule): work is chunked into small batches with
// a short pause between them so the shared Neon pool is never saturated, and a
// module-level guard prevents overlapping runs (initial pass vs. cron vs. manual
// trigger). The default adapter is a static bundled dataset, so there are no
// external sockets/FDs to leak; the batching keeps DB pressure bounded.
// =============================================================================
import { storage } from "../storage";
import type { OutletEnrichmentAdapter, OutletEnrichmentFields } from "./types";
import { ReferenceDatasetAdapter } from "./referenceAdapter";

// Registered adapters, highest-priority first. The first adapter that returns a
// result for a given field wins for that field. Add licensed-feed adapters here.
const ADAPTERS: OutletEnrichmentAdapter[] = [new ReferenceDatasetAdapter()];

// Fields the enrichment service is allowed to write. Deliberately excludes
// `role` and `confirmationStatus` flips toward "contributing" — promotion is a
// human-only decision made via manual override in the oversight surface.
const ENRICHABLE_FIELDS: (keyof OutletEnrichmentFields)[] = [
  "originCountry",
  "originRegion",
  "factuality",
];

const BATCH_SIZE = 25;
const BATCH_PAUSE_MS = 250;
const MIN_CONFIDENCE = 0.5;

let enrichmentRunning = false;

export interface EnrichmentRunSummary {
  processed: number;
  confirmed: number;
  updated: number;
  skipped: number;
  alreadyRunning?: boolean;
  trigger: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run a full enrichment pass over the registry. Safe to call repeatedly and
 * concurrently — overlapping calls short-circuit via the run guard.
 */
export async function runOutletEnrichment(
  trigger: string = "manual",
): Promise<EnrichmentRunSummary> {
  if (enrichmentRunning) {
    console.log(`[Enrichment] Skipped (${trigger}) — a pass is already running`);
    return { processed: 0, confirmed: 0, updated: 0, skipped: 0, alreadyRunning: true, trigger };
  }
  enrichmentRunning = true;
  const summary: EnrichmentRunSummary = { processed: 0, confirmed: 0, updated: 0, skipped: 0, trigger };

  try {
    const rows = await storage.getOutletRegistry();
    console.log(`[Enrichment] Starting pass (${trigger}) over ${rows.length} outlets`);

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      for (const row of batch) {
        summary.processed++;
        try {
          const input = {
            key: row.key,
            canonicalName: row.canonicalName,
            aliases: row.aliases ?? [],
            domains: row.domains ?? [],
          };

          // Merge adapter results: first adapter to fill a field wins.
          const merged: OutletEnrichmentFields = {};
          let matched = false;
          let topConfidence = 0;
          for (const adapter of ADAPTERS) {
            const result = await adapter.enrich(input);
            if (!result || result.confidence < MIN_CONFIDENCE) continue;
            matched = true;
            topConfidence = Math.max(topConfidence, result.confidence);
            for (const f of ENRICHABLE_FIELDS) {
              const v = result.fields[f];
              if (v !== undefined && v !== null && merged[f] === undefined) {
                (merged as Record<string, unknown>)[f] = v;
              }
            }
          }

          if (!matched) {
            summary.skipped++;
            continue;
          }

          const changed = await storage.applyOutletEnrichment(
            row.id,
            merged as Record<string, unknown>,
            ADAPTERS.map((a) => a.name).join("+"),
            topConfidence >= 0.9, // only a strong (domain-grade) match confirms
          );
          if (changed.updatedFields > 0) summary.updated++;
          if (changed.confirmed) summary.confirmed++;
        } catch (err) {
          console.error(`[Enrichment] Error enriching "${row.canonicalName}":`, err);
          summary.skipped++;
        }
      }
      if (i + BATCH_SIZE < rows.length) await sleep(BATCH_PAUSE_MS);
    }

    console.log(
      `[Enrichment] Pass complete (${trigger}) — processed ${summary.processed}, ` +
        `updated ${summary.updated}, confirmed ${summary.confirmed}, skipped ${summary.skipped}`,
    );
    return summary;
  } finally {
    enrichmentRunning = false;
  }
}

export function isEnrichmentRunning(): boolean {
  return enrichmentRunning;
}
