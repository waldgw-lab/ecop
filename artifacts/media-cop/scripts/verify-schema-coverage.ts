/**
 * verify-schema-coverage.ts
 *
 * Checks that every table declared in shared/schema.ts will be created by
 * server/migrate.ts on a fresh database.
 *
 * WHY: The long-lived dev DB masks missing-table bugs because every table
 * already exists locally. A fresh or reset deployment will 42P01
 * ("relation does not exist") at runtime unless migrate.ts explicitly
 * creates the table.  This script catches that gap automatically.
 *
 * Two-layer check:
 *
 *  Layer 1 — Static analysis (always runs, no DB required)
 *    Parses shared/schema.ts for every pgTable("name") declaration and
 *    server/migrate.ts for every table it would create (direct CREATE TABLE
 *    IF NOT EXISTS statements AND loop-constructed tables listed in string
 *    arrays / object arrays).  Reports any schema.ts table absent from
 *    migrate.ts and exits 1.
 *
 *  Layer 2 — Live check (runs when DATABASE_URL is set)
 *    Calls ensureDatabaseSchema() (idempotent, touches the connected DB) then
 *    queries information_schema to confirm every expected table exists in the
 *    public schema.  This catches tables whose CREATE block exists in
 *    migrate.ts but whose SQL is somehow wrong (bad column type, FK ordering
 *    error, etc.) that the static check cannot see.
 *    NOTE: Because the dev DB already has every table, this layer is most
 *    useful in CI against a freshly provisioned database.  On the long-lived
 *    dev DB it still confirms nothing was accidentally dropped.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more tables are missing or uncreated
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Layer 1 — Static analysis
// ---------------------------------------------------------------------------

/** Extract every table name declared in shared/schema.ts via pgTable(). */
function extractSchemaTableNames(filePath: string): string[] {
  const src = fs.readFileSync(filePath, 'utf8');
  const matches = [...src.matchAll(/pgTable\(\s*["']([^"']+)["']/g)];
  return [...new Set(matches.map(m => m[1]))].sort();
}

/**
 * Extract every table name that server/migrate.ts will create.
 * Handles three patterns:
 *
 *   A) Direct:
 *      CREATE TABLE IF NOT EXISTS some_table (
 *
 *   B) Object-array loop (e.g. botPostTables):
 *      { table: 'some_table', prefix: '...' }
 *
 *   C) String-array loop (tables listed as plain strings):
 *      ['some_table', 'another_table', ...]
 *      used with for…of and sql.raw(table) / sql.raw(tableName) etc.
 */
function extractMigrateTableNames(filePath: string): Set<string> {
  const src = fs.readFileSync(filePath, 'utf8');
  const result = new Set<string>();

  // Pattern A — literal CREATE TABLE IF NOT EXISTS
  for (const m of src.matchAll(
    /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_]+)/gi,
  )) {
    result.add(m[1].toLowerCase());
  }

  // Pattern B — object arrays: { table: 'name', ... }
  for (const m of src.matchAll(/\btable\s*:\s*['"]([a-z_]+)['"]/g)) {
    result.add(m[1].toLowerCase());
  }

  // Pattern C — string arrays used as table-name lists in loop bodies that
  // contain sql.raw(  ).  Heuristic: find string literals in array/argument
  // contexts adjacent to sql.raw usage in the same block.
  //
  // Strategy: for every block that references sql.raw, extract any quoted
  // identifier-looking strings (snake_case, ends in _posts/_items/_settings
  // etc.) nearby.
  const sqlRawBlocks = src.split('sql.raw(');
  for (const block of sqlRawBlocks.slice(1)) {
    // Look backwards up to 500 chars for string literals that look like table names
    const before = src.slice(
      Math.max(0, src.indexOf(block, 0) - 500),
      src.indexOf(block, 0),
    );
    for (const m of before.matchAll(/['"]([a-z][a-z0-9_]*)['"],?\s*/g)) {
      if (m[1].includes('_')) result.add(m[1]);
    }
  }

  return result;
}

const schemaFile  = path.join(ROOT, 'shared', 'schema.ts');
const migrateFile = path.join(ROOT, 'server', 'migrate.ts');

const schemaTables  = extractSchemaTableNames(schemaFile);
const migrateTables = extractMigrateTableNames(migrateFile);

console.log(`\n📋 Tables declared in shared/schema.ts  : ${schemaTables.length}`);
console.log(`📋 Tables covered by  server/migrate.ts : ${migrateTables.size}\n`);

const missingFromMigrate = schemaTables.filter(t => !migrateTables.has(t));

if (missingFromMigrate.length > 0) {
  console.error(
    '❌ Tables in shared/schema.ts that are NOT created by server/migrate.ts:',
  );
  for (const t of missingFromMigrate) {
    console.error(`   • ${t}`);
  }
  console.error(
    '\n   Fix: add a "CREATE TABLE IF NOT EXISTS <table> (...)" block to the',
    '\n   comprehensive backfill section of server/migrate.ts for each table,',
    '\n   OR list the table name in the botPostTables / loop array already there.',
  );
} else {
  console.log(
    '✅ Static check passed — every schema.ts table is covered by migrate.ts.',
  );
}

// ---------------------------------------------------------------------------
// Layer 2 — Live check
// ---------------------------------------------------------------------------

async function liveCheck(expectedTables: string[]): Promise<boolean> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log('\n⚠️  DATABASE_URL not set — skipping live check.');
    return true;
  }

  console.log(
    '\n🔄 DATABASE_URL found — running live check against the connected database...',
  );
  console.log(
    '   (ensureDatabaseSchema() is idempotent; this is safe to run at any time.)',
  );

  try {
    // Run the real migrator — idempotent, no harm on a healthy DB.
    const { ensureDatabaseSchema } = await import('../server/migrate.js');
    await ensureDatabaseSchema();

    // Now query which tables actually exist in the public schema.
    const { Pool, neonConfig } = await import('@neondatabase/serverless');
    const ws = await import('ws');
    neonConfig.webSocketConstructor = ws.default;

    const pool = new Pool({ connectionString: dbUrl });
    let liveOk = false;
    try {
      const res = await pool.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
      );
      const liveTables = new Set(res.rows.map(r => r.table_name));

      const missingLive = expectedTables.filter(t => !liveTables.has(t));
      if (missingLive.length > 0) {
        console.error(
          '\n❌ Tables expected but NOT present in the public schema after migration:',
        );
        for (const t of missingLive) {
          console.error(`   • ${t}`);
        }
        console.error(
          '\n   This means the CREATE TABLE block for these tables either does not',
          '\n   exist in migrate.ts or failed silently. Fix migrate.ts then re-run.',
        );
        liveOk = false;
      } else {
        console.log(
          `✅ Live check passed — all ${expectedTables.length} expected tables exist in the public schema.`,
        );
        liveOk = true;
      }
    } finally {
      await pool.end();
    }
    return liveOk;
  } catch (err) {
    console.error('\n❌ Live check failed with an unexpected error:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Final verdict
// ---------------------------------------------------------------------------

const staticOk = missingFromMigrate.length === 0;

liveCheck(schemaTables)
  .then(liveOk => {
    if (staticOk && liveOk) {
      console.log(
        '\n✅ Schema coverage check complete — no missing tables detected.',
      );
      process.exit(0);
    } else {
      console.error(
        '\n❌ Schema coverage check FAILED — see errors above.',
        '\n   Add missing tables to server/migrate.ts and re-run this script.',
      );
      process.exit(1);
    }
  })
  .catch(err => {
    console.error('Unexpected error running schema coverage check:', err);
    process.exit(1);
  });
