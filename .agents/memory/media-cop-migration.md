---
name: Media COP legacy transplant
description: How the imported Pilot Bravo app is wired into this monorepo and what to watch for
---

- The legacy single-repo Express+Vite app was transplanted wholesale into `artifacts/media-cop` keeping its own layout (client/server/shared, own vite config, drizzle config). It is NOT contract-first; do not force it into the api-spec/codegen flow.
- **Why:** app is ~100k LOC with its own conventions; restructuring risked breaking a working product during migration.
- Its server owns the whole path space `/` *including* `/api`. The scaffold api-server artifact was parked at `/scaffold-api` (toml paths + `app.use` prefix changed) to free `/api`. Don't add new routes to the scaffold api-server for this product — add them to `artifacts/media-cop/server`.
- Drizzle `push` from `artifacts/media-cop` hits interactive column-conflict prompts because the server also self-creates tables at boot (`ensureDatabaseSchema`). Prefer restoring the user's DB export / letting boot-time DDL run over `drizzle-kit push`.
- The X scraper's Chromium lookup once used a synchronous `find /nix/store` scan that blocked Node's event loop for minutes, freezing all HTTP (endless spinners / blank preview). Chromium is now installed as a Nix system dep and the lookup is cached with no store scan — never reintroduce sync full-disk scans in this server process.
- App expects env: AI_INTEGRATIONS_ANTHROPIC_*/OPENROUTER_* (Replit AI Integrations — already provisioned), object storage vars (provisioned), plus many user-supplied keys (OpenAI, Twilio, Resend, DataMinr, relay keys, admin passwords). Missing keys degrade features, not boot.
