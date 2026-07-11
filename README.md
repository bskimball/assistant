# Compass

Compass is a private, voice-first personal AI coach for a two-person household. It combines daily planning, tasks, fitness, nutrition, finance, weekly review, analytics, and conversational coaching in one TanStack Start application.

## Stack

- TanStack Start, React, and TanStack Router
- Cloudflare Workers with R2 for domain data and D1 for authentication tables
- Better Auth with Google OAuth and passkeys
- Tailwind CSS and shadcn/ui
- Vite+ for development, checks, tests, and builds
- Grok for AI features, with deterministic fallbacks when no API key is configured

## Getting started

```bash
npm install
npm run dev
```

`npm run dev` starts the app on port 3000 using the Cloudflare Vite plugin and local emulated bindings. Use `npm run dev:cf` when full Wrangler binding fidelity is needed.

Local configuration belongs in `.dev.vars` and must not be committed. Authentication degrades gracefully in local development when OAuth is not configured; production fails closed.

## Quality commands

```bash
npm run check        # format/lint checks and TypeScript
npm run test         # test suite
npm run build        # check, test, production build, and output sanitization
npm run build:only   # production build without the quality gate
npm run generate-routes
```

CI and Workers Builds use `npm run build`, so formatting, type, or test failures block deployment.

## Architecture

- `src/routes/` — file-based routes and page UI
- `src/components/` — shared application and shadcn components
- `src/lib/` — client-safe domain types, state, and pure helpers
- `src/server/` — route-facing server functions and domain operations
- `src/server/adapters/` — Cloudflare and external API integrations
- `src/worker-entry.ts` — Worker entry and scheduled jobs
- `docs/adr/` — architecture decision records
- `docs/ai/` — agent-readable architecture and domain documentation

Domain data is accessed through server functions. Personal health, nutrition, profile, and coaching data is member-scoped; household finance and shared tasks use the household scope. See `AGENTS.md` and ADR-017 before changing persistence or authorization boundaries.

`src/routeTree.gen.ts` and Cloudflare type declarations are generated artifacts. Do not edit them manually.

## Cloudflare setup

Create the required R2 bucket and refresh generated binding types when configuring a new environment:

```bash
npx wrangler r2 bucket create assistant-data
npm run cf-typegen
```

Set production secrets with Wrangler:

```bash
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put GOOGLE_CLIENT_SECRET
# Optional AI features
npx wrangler secret put GROK_API_KEY
```

Non-sensitive production variables such as `GOOGLE_CLIENT_ID`, `BETTER_AUTH_URL`, and `PUBLIC_APP_URL` are configured as Cloudflare variables. A real D1 database ID and production route are configured in `wrangler.jsonc`.

## Deployment

```bash
npm run deploy
```

This runs the complete quality gate before deploying through Wrangler. See `docs/adr/001-cloudflare-r2-deployment.md` and `wrangler.jsonc` for deployment details.
