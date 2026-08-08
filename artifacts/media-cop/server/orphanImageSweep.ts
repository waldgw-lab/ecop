import { sql } from 'drizzle-orm';
import { db } from './db';
import { ObjectStorageService } from './objectStorage';

// =============================================================================
// Orphaned object-storage image sweep (Task #765)
// -----------------------------------------------------------------------------
// When curated (or any) media is reset — e.g. the Straits Times / outlet-logo
// heal nulls `og_image_url`, a re-enrichment replaces the stored image, or a row
// is deleted — the previously persisted file in object storage is left behind
// with no DB reference. Over time these orphans accumulate and consume quota.
//
// CRITICAL SAFETY NOTE: curated images do NOT live in a dedicated directory. The
// enrichment write path (persistImageToStorage -> uploadStreamImage) stores every
// persisted external image under the SHARED `/objects/stream-images/` prefix,
// which is also used by the main feed (headlines), manual submissions, some
// social posts, etc. Deleting a stream-images file just because it is missing
// from `curated_items` would destroy thousands of LIVE main-feed / manual images.
//
// Therefore the "referenced" set is built by scanning EVERY text column of EVERY
// public table (via information_schema) for a `/objects/stream-images/…` value.
// A new table/column that ever stores a stream-images path automatically protects
// its files — we never have to remember to add it here.
//
// Additional guards:
//  - Age floor: a file younger than `minAgeMs` (default 7 days) is never deleted,
//    so a file that was just uploaded but whose DB row has not committed yet (or
//    is mid-enrichment in another process) is safe.
//  - Bounded: at most `maxDeletions` files removed per run; the rest defer to the
//    next run.
//  - Rate-limited: a small spacing between deletes so the sweep never hammers the
//    storage backend or blocks other work.
//  - Never throws: all failures are caught and reported in the result.
//  - Single-flight: an in-process guard prevents overlapping runs.
// =============================================================================

const STREAM_IMAGES_PREFIX = 'stream-images/';
const DEFAULT_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_DELETIONS = 1000;
const DELETE_SPACING_MS = 50;

let isRunning = false;
let lastRunAt: number | null = null;

export interface OrphanSweepResult {
  ran: boolean;
  skippedReason?: string;
  dryRun: boolean;
  deletionsAllowed: boolean;
  scanned: number;
  referenced: number;
  columnsScanned: number;
  columnsFailed: number;
  orphanCandidates: number;
  tooYoungSkipped: number;
  unknownAgeSkipped: number;
  deleted: number;
  errors: number;
  durationMs: number;
}

function entityIdFromPath(p: string | null | undefined): string | null {
  if (!p) return null;
  const marker = '/objects/';
  if (!p.startsWith(marker)) return null;
  return p.slice(marker.length); // e.g. "stream-images/1234-auto-1234.jpg"
}

/**
 * Build the set of `/objects/stream-images/` entity ids that are still
 * referenced ANYWHERE in the database. Catalog-driven so a new column that
 * stores a stream-images path automatically protects its files. Returns the set
 * plus how many text columns were scanned (for logging / diagnostics).
 */
async function collectReferencedStreamImages(): Promise<{ referenced: Set<string>; columnsScanned: number; columnsFailed: number }> {
  const referenced = new Set<string>();
  const cols = await db.execute(sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('text', 'character varying', 'character')
    ORDER BY table_name, column_name
  `);
  const colRows = (cols.rows ?? []) as Array<{ table_name: string; column_name: string }>;

  // Group text columns by table so we can scan each table ONCE (OR across its
  // columns) instead of one query per column — a big reduction in round-trips
  // for the daily job. We UNNEST each matching column into a single value stream.
  const byTable = new Map<string, string[]>();
  for (const { table_name, column_name } of colRows) {
    const list = byTable.get(table_name) ?? [];
    list.push(column_name);
    byTable.set(table_name, list);
  }

  let columnsScanned = 0;
  let columnsFailed = 0;
  for (const [table, columns] of Array.from(byTable.entries())) {
    columnsScanned += columns.length;
    // Identifiers come from information_schema (trusted system catalog); quote
    // them defensively. Build: SELECT unnest(ARRAY["c1","c2",...]) AS v FROM "t"
    // WHERE "c1" LIKE ... OR "c2" LIKE ... — only rows/cols holding a
    // stream-images path contribute values.
    const arrayExpr = columns.map((c) => `"${c}"`).join(', ');
    const whereExpr = columns
      .map((c) => `"${c}" LIKE '/objects/stream-images/%'`)
      .join(' OR ');
    try {
      const res = await db.execute(sql.raw(
        `SELECT DISTINCT unnest(ARRAY[${arrayExpr}]) AS v FROM "${table}" WHERE ${whereExpr}`,
      ));
      const vrows = (res.rows ?? []) as Array<{ v: string | null }>;
      for (const r of vrows) {
        const id = entityIdFromPath(r.v);
        if (id) referenced.add(id);
      }
    } catch {
      // Table/columns not scannable for whatever reason (mixed types in the
      // ARRAY, etc.) — fall back to scanning this table's columns individually so
      // a single odd column can't cause us to under-count references (which would
      // risk deleting a live file). A failure here must never drop a reference.
      for (const c of columns) {
        try {
          const res = await db.execute(sql.raw(
            `SELECT DISTINCT "${c}" AS v FROM "${table}" WHERE "${c}" LIKE '/objects/stream-images/%'`,
          ));
          const vrows = (res.rows ?? []) as Array<{ v: string | null }>;
          for (const r of vrows) {
            const id = entityIdFromPath(r.v);
            if (id) referenced.add(id);
          }
        } catch {
          // Individual column not scannable even on its own — a reference MAY
          // have been dropped for this column. Record it so the caller can
          // refuse to delete this run (fail-closed) rather than risk removing a
          // file that is actually still referenced.
          columnsFailed++;
        }
      }
    }
  }
  return { referenced, columnsScanned, columnsFailed };
}

/**
 * Run the orphaned stream-images sweep.
 *
 * @param opts.dryRun          When true, never deletes (default false).
 * @param opts.allowDelete     Environment gate. The daily cron passes
 *                             `isDeployment` here so that only the deployed app
 *                             (whose DB is authoritative for the SHARED bucket)
 *                             performs deletions. Effective delete =
 *                             allowDelete && !dryRun.
 * @param opts.minAgeMs        Age floor; files younger than this are never
 *                             deleted (default 7 days).
 * @param opts.maxDeletions    Upper bound on deletions per run (default 1000).
 * @param opts.reason          Free-text label for the log line.
 */
export async function runOrphanImageSweep(opts: {
  dryRun?: boolean;
  allowDelete?: boolean;
  minAgeMs?: number;
  maxDeletions?: number;
  reason?: string;
} = {}): Promise<OrphanSweepResult> {
  const dryRun = opts.dryRun ?? false;
  // Default fail-closed: a caller must opt IN to deletions. Both real callers
  // (the deployment-gated cron and the admin route) pass allowDelete explicitly;
  // any future caller that forgets gets a safe scan-only run.
  let deletionsAllowed = (opts.allowDelete ?? false) && !dryRun;
  const minAgeMs = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const maxDeletions = opts.maxDeletions ?? DEFAULT_MAX_DELETIONS;
  const reason = opts.reason ?? 'manual';
  const started = Date.now();

  const result: OrphanSweepResult = {
    ran: false,
    dryRun,
    deletionsAllowed,
    scanned: 0,
    referenced: 0,
    columnsScanned: 0,
    columnsFailed: 0,
    orphanCandidates: 0,
    tooYoungSkipped: 0,
    unknownAgeSkipped: 0,
    deleted: 0,
    errors: 0,
    durationMs: 0,
  };

  if (isRunning) {
    result.skippedReason = 'already-running';
    result.durationMs = Date.now() - started;
    console.log('[OrphanImageSweep] skipped — a sweep is already running');
    return result;
  }
  isRunning = true;
  try {
    result.ran = true;

    const { referenced, columnsScanned, columnsFailed } = await collectReferencedStreamImages();
    result.referenced = referenced.size;
    result.columnsScanned = columnsScanned;
    result.columnsFailed = columnsFailed;

    if (columnsFailed > 0 && deletionsAllowed) {
      // The reference scan could not read every text column, so the referenced
      // set may be UNDER-counted. Deleting on an under-count risks removing a
      // file that is still live, so degrade this run to scan-only. The next run
      // (when the column is readable again) will delete any true orphans.
      deletionsAllowed = false;
      result.deletionsAllowed = false;
      result.skippedReason = `reference-scan incomplete: ${columnsFailed} column(s) unscannable — forced scan-only`;
      console.warn(`[OrphanImageSweep] ${result.skippedReason} (no deletions this run)`);
    }

    const storageService = new ObjectStorageService();
    let files: Array<{ file: any; entityId: string; timeCreatedMs: number }>;
    try {
      files = await storageService.listPrivateObjectsByPrefix(STREAM_IMAGES_PREFIX);
    } catch (e: any) {
      result.errors++;
      result.skippedReason = `list-failed: ${e?.message || e}`;
      console.error('[OrphanImageSweep] listing failed:', e);
      return result;
    }
    result.scanned = files.length;

    const now = Date.now();
    const candidates: Array<{ file: any; entityId: string }> = [];
    for (const f of files) {
      if (referenced.has(f.entityId)) continue;
      if (!f.timeCreatedMs) {
        // Unknown creation time — never delete (fail-safe).
        result.unknownAgeSkipped++;
        continue;
      }
      if (now - f.timeCreatedMs < minAgeMs) {
        result.tooYoungSkipped++;
        continue;
      }
      candidates.push({ file: f.file, entityId: f.entityId });
    }
    result.orphanCandidates = candidates.length;

    console.log(
      `[OrphanImageSweep] reason=${reason} dryRun=${dryRun} deletionsAllowed=${deletionsAllowed} ` +
      `scanned=${result.scanned} referenced=${result.referenced} (columns=${columnsScanned}) ` +
      `candidates=${result.orphanCandidates} tooYoung=${result.tooYoungSkipped} unknownAge=${result.unknownAgeSkipped}`,
    );

    if (!deletionsAllowed) {
      console.log(
        `[OrphanImageSweep] no deletions performed (${dryRun ? 'dry-run' : 'deletion not allowed in this environment'})`,
      );
      return result;
    }

    for (const c of candidates) {
      if (result.deleted >= maxDeletions) {
        console.log(
          `[OrphanImageSweep] hit maxDeletions=${maxDeletions}; ` +
          `${candidates.length - result.deleted} candidate(s) deferred to next run`,
        );
        break;
      }
      try {
        await c.file.delete();
        result.deleted++;
        if (result.deleted % 100 === 0) {
          console.log(`[OrphanImageSweep] deleted ${result.deleted}/${Math.min(candidates.length, maxDeletions)}...`);
        }
      } catch (e: any) {
        result.errors++;
        console.error(`[OrphanImageSweep] delete failed for ${c.entityId}: ${e?.message || e}`);
      }
      if (DELETE_SPACING_MS > 0) {
        await new Promise((r) => setTimeout(r, DELETE_SPACING_MS));
      }
    }

    lastRunAt = Date.now();
    console.log(`[OrphanImageSweep] done: deleted=${result.deleted} errors=${result.errors}`);
    return result;
  } catch (e: any) {
    result.errors++;
    result.skippedReason = `error: ${e?.message || e}`;
    console.error('[OrphanImageSweep] unexpected error:', e);
    return result;
  } finally {
    result.durationMs = Date.now() - started;
    isRunning = false;
  }
}

export function getOrphanImageSweepStatus() {
  return { isRunning, lastRunAt };
}
