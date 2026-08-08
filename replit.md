# Media Common Operating Picture (MCOP / Pilot Bravo)

Defense-news aggregation app for military leadership: a Bloomberg-Terminal-style feed with scrapers, AI prioritization, a war dashboard, curated lanes, Truth Social/X feeds, and team views.

## Run & Operate

- `pnpm --filter @workspace/media-cop run dev` — run the main app (Express serves the Vite frontend; port from `PORT`, workflow `artifacts/media-cop: web`)
- `pnpm --filter @workspace/media-cop run build` / `run start` — production build and run
- `pnpm --filter @workspace/api-server run dev` — scaffold API server (parked at `/scaffold-api`, unused by MCOP)
- Required env: `DATABASE_URL` (runtime-managed Postgres); many optional API keys enable individual data sources

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Main app: legacy single-package Express + React/Vite app transplanted whole into `artifacts/media-cop`
- DB: PostgreSQL (Neon-compatible driver) + Drizzle ORM; schema in `artifacts/media-cop/shared/schema.ts`

## Where things live

- `artifacts/media-cop/client/` — React frontend
- `artifacts/media-cop/server/` — Express server, scrapers, schedulers, routes (`routes.ts`), storage layer (`storage.ts`)
- `artifacts/media-cop/shared/schema.ts` — Drizzle schema (source of truth)
- `artifacts/media-cop/server/migrate.ts` — boot-time table creation (`ensureDatabaseSchema`)

## Architecture decisions

- The legacy app was migrated wholesale and keeps its own structure; it does NOT use the monorepo's api-spec/codegen flow. Add new routes in `artifacts/media-cop/server`, not the scaffold api-server.
- media-cop owns path `/` including `/api`; the scaffold api-server was moved to `/scaffold-api` to avoid shadowing.
- Anthropic + OpenRouter access goes through Replit AI Integrations (env auto-provisioned). Object storage bucket provisioned via App Storage.
- Production deployment must be a VM (always-on) deployment — the app runs scheduled scrapers.

## Product

- Live news feed with AI-prioritized top stories, IE highlights, DataMinr first alerts
- Truth Social / U.S. X / OSINT X feeds, custom feeds, curated lanes
- Classic / Visual / Curated / Team views; admin and submission flows gated by passwords

## User preferences

- User is non-technical-leaning; keep messages simple and avoid internal tool/skill names.

## Gotchas

- Avoid `drizzle-kit push` here: boot-time DDL differs slightly from schema and triggers interactive conflict prompts. Prefer the DB export restore or boot-time creation.
- Many features are dormant until their API keys are added as secrets (OpenAI, DataMinr, Twilio, Resend, relays, etc.); the app still boots without them.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
