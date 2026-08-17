#!/bin/bash
set -e
pnpm install --frozen-lockfile
# NOTE: deliberately NO drizzle push here. The media-cop schema file and the
# live database intentionally differ (legacy transplant); `drizzle-kit push`
# proposes DROPPING real tables with live data (first_alerts, headlines,
# manual_submissions, ...). Schema changes for media-cop are applied manually
# with targeted SQL, never via push.
