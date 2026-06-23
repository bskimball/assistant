# Architecture — Personal Life-Improvement Assistant

This is the agent-facing map for where new work belongs. Keep this document current when module boundaries change.

## System Shape

The app is a TanStack Start React app deployed to Cloudflare. Client routes render the daily dashboard, weekly review, analytics, profile, and kanban views. Server work is exposed through TanStack `createServerFn` modules under `src/server`.

Persistent domain data lives in Cloudflare R2. Cloudflare D1 is used only for Better Auth tables. AI features call Grok through a server-side adapter and must keep deterministic fallbacks so the app still works without `GROK_API_KEY`.

## Source Boundaries

**Client-safe shared code**

- `src/lib/domain.ts`: runtime domain types and pure helpers that can be imported by routes and server code.
- `docs/ai/core-domain-model.ts`: agent-readable model mirror. Update it with `src/lib/domain.ts` and the relevant ADR when domain types change.
- `src/lib/auth-client.ts` and UI/component code: browser-safe only.

**Route-facing server functions**

- `src/server/domain.ts`: `createServerFn` wrappers for daily aggregates, voice processing, workout/nutrition/finance/productivity reads and writes, weekly review, exercise library, and soft-delete maintenance.
- `src/server/coach.ts`: `createServerFn` entry points for daily coaching and weekly narratives.
- `src/server/todos.ts`: legacy todo server-function compatibility while productivity migrates to daily aggregates.
- `src/server/session.ts`: lightweight auth-state server function for route guards.

Keep these wrappers thin: validate input, require auth for writes, call plain implementation functions.

**Plain server-side domain behavior**

- `src/server/domain-impl.ts`: daily dashboard composition, aggregate loaders/savers, voice intent parsing and execution, soft-delete maintenance, nutrition macro estimation, finance transactions, workout session append logic, and legacy todo compatibility hooks.
- Add deeper implementation modules only when `domain-impl.ts` becomes too broad. New modules should still be plain functions, not `createServerFn` wrappers.

**Persistence boundary**

- `src/server/store.ts`: the domain store interface. Domain implementation code should use `getDomainStore()` instead of importing R2 directly.
- `src/server/adapters/r2.ts`: Cloudflare R2 binding, key construction, JSON/JSONL object access, voice/AI per-object writes, and delete-index shard helpers.
- `src/server/adapters/d1.ts`: Better Auth D1/Drizzle access only.

**AI boundary**

- `src/server/adapters/ai.ts`: Grok key lookup, OpenAI-compatible xAI transport, and JSON-response parsing.
- Coach and voice code should call this adapter, not `fetch("https://api.x.ai/...")` directly.
- Keep deterministic fallback behavior in the caller so missing or failing AI does not break the app.

## Request/Data Flow

1. A route imports a server function from `src/server/domain.ts`, `coach.ts`, `todos.ts`, or `session.ts`.
2. The server-function wrapper validates input and gates write paths with `requireAuthSession`.
3. The wrapper delegates to a plain implementation function in `src/server/domain-impl.ts` or local helper functions in `coach.ts`.
4. Domain implementation uses `getDomainStore()` for R2-backed daily, weekly, reference, and log access.
5. R2 object keys are constructed only by `src/server/adapters/r2.ts`.
6. AI calls flow through `src/server/adapters/ai.ts`; results are persisted into daily plans or AI/voice logs where appropriate.

## Storage Model

All domain data is partitioned under `assistant/brian/`.

- Daily aggregates: `assistant/brian/{domain}/{YYYY-MM-DD}.json`
- Weekly aggregates: `assistant/brian/{domain}/{YYYY}-W{week}.json`
- Reference data: `assistant/brian/{collection}.json`
- Append logs: `assistant/brian/{domain}/{YYYY-MM-DD}.jsonl`
- Voice transcript objects: `assistant/brian/ai/transcripts/{id}.json`
- AI interaction objects: `assistant/brian/ai/interactions/{id}.json`
- Soft-delete index shards: `assistant/brian/meta/deleted/{YYYY-MM-DD}.json`

D1 is not a domain store. Do not put nutrition, finance, productivity, coaching, or workout state in D1 unless a future ADR explicitly changes the persistence model.

## Where To Put New Work

- New domain type or invariant: update `src/lib/domain.ts`, `docs/ai/core-domain-model.ts`, `docs/ai/glossary.md`, and the relevant ADR.
- New server mutation/query: add plain behavior in `src/server/domain-impl.ts` or a deeper plain module, then expose it through a thin wrapper in `src/server/domain.ts`.
- New persistent collection: add store usage through `src/server/store.ts`; add R2 key helpers in `src/server/adapters/r2.ts` only if the existing daily/weekly/ref/log methods are insufficient.
- New AI feature: add transport/provider behavior to `src/server/adapters/ai.ts`, keep prompt/domain orchestration in the domain or coach layer, and provide a deterministic fallback.
- New auth or session behavior: use `src/lib/auth.ts`, `src/lib/auth-client.ts`, `src/server/session.ts`, and `src/server/adapters/d1.ts`.

## Pitfalls

- Do not recreate `src/lib/server`; server-only code belongs under `src/server`.
- Do not import `src/server/adapters/r2.ts` from route/domain behavior. Use `src/server/store.ts`.
- Do not put `createServerFn` inside domain implementation modules. Keep server-function wrappers route-facing.
- Do not directly import `cloudflare:workers` in modules that may be pulled through client-transformed route graphs. Keep Cloudflare virtual imports inside server-only adapters or use an adapter pattern that Vite can build.
- Do not remove deterministic AI fallbacks. Voice and coaching must degrade gracefully without `GROK_API_KEY`.
- Do not treat legacy `todos.json` as the future model. It remains only as a compatibility bridge while productivity uses daily aggregates.

## Evidence

- `src/server/domain.ts`
- `src/server/domain-impl.ts`
- `src/server/coach.ts`
- `src/server/todos.ts`
- `src/server/session.ts`
- `src/server/store.ts`
- `src/server/adapters/ai.ts`
- `src/server/adapters/r2.ts`
- `src/server/adapters/d1.ts`
- `docs/adr/015-server-module-layout.md`
