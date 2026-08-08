#!/bin/bash
set -e
npm install
# Apply schema via the app's own idempotent migrator (guarded raw SQL), the same
# path server boot uses. Avoids `drizzle-kit push`, which prompts interactively on
# pre-existing drift and fails under post-merge's closed stdin (no TTY).
npx tsx scripts/run-migrate.ts
