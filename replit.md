# Financial Stability Watch — Media COP mirror

## Active product in this copy

This mirror is now a restricted internal financial-stability monitor for military/national-security users. It uses public news feeds, public historical observations and the existing Dataminr First Alert connection. No new paid subscriptions have been activated.

- The financial entry replaces the old dashboard at `/` and `/curated`; the original military implementation remains in the repository, not in the active runtime.
- Dedicated financial ingestion, ranking and persistence are separate from the original military tables. Financial startup refuses a database matching the separately configured original production database.
- Legacy military schedulers, old API/relay endpoints, outbound notifications and startup data repairs do not run in financial mode.
- Preserve the existing AI shutdown setting. Financial scores are transparent rule-based screening with independent confidence labels, not AI-generated assessments or predictions.
- The briefing assistant is deliberately a source-grounded rule-based data guide while external AI is paused; adding chat must not silently re-enable provider calls or legacy AI jobs. It reads current finance snapshots, cites observation dates, keeps conversations only in tab memory, and declines unsupported topics.
- Internal access uses the app's existing team password/session mechanism, including in development; there is no development data-access bypass. No new authentication provider was introduced.
- Social account listings are a reference roster, not direct live X collection. Social links received through Dataminr remain attributed, unconfirmed signals.
- Financial social posts also come from public Bluesky publisher accounts, screened for financial relevance and cached for 15 minutes. Only original-account posts with publication dates and original links qualify; attribution is not independent claim verification. Meltwater's key is present, but no dedicated finance-social saved search or export was activated.
- Public CSV downloads back the historical indicators; no values are invented for missing observations. CNN Fear & Greed is explicitly unavailable until permitted data access is established.
- The economic overview joins official released observations with indicative Yahoo Finance quotes. Market downloads are bounded/cached for 15 minutes; daily/monthly public indicators refresh on an hourly budget. A manual refresh does not bypass those budgets.
- Oil spot observations, rolling near-contract futures and named forward contracts are distinct instruments. Quote changes use the previous completed daily bar, never a year-range `chartPreviousClose`; these are not certified settlements or executable live prices.
- Macro comparisons use each series' latest observation and explicit historical baseline dates. CPI/output growth use matching prior-year months; missing monthly baselines are not filled. Fed funds futures imply contract-month average effective rates, not meeting probabilities.
- Production hosting remains in its prior static configuration; do not publish the interactive financial service without a deliberate authenticated-server deployment review.

The following sections describe the retained legacy framework and migration context.

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
