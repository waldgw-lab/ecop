// Standalone runner for the app's idempotent schema migrator.
//
// Used by scripts/post-merge.sh so a merge applies schema changes the SAME way
// the app does at boot (server/index.ts -> ensureDatabaseSchema), via guarded
// raw idempotent SQL. This deliberately AVOIDS `drizzle-kit push`, which is
// interactive: on pre-existing drift (e.g. the replit_users_email_unique
// constraint declared in shared/models/auth.ts but absent on the live table) it
// prompts to truncate, and with stdin closed in post-merge it gets EOF and the
// whole setup fails.
import { ensureDatabaseSchema } from "../server/migrate";

ensureDatabaseSchema()
  .then(() => {
    console.log("Post-merge schema sync complete.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Post-merge schema sync failed:", err);
    process.exit(1);
  });
