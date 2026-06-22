# ADR-010: Authentication & D1-Backed Sessions

**Status**: Accepted
**Date**: 2026-06-22
**Deciders**: Brian Kimball

## Context

The assistant began as a single-user app with a fixed user prefix (`USER_ID = "brian"`) and no authentication — acceptable while running locally, unacceptable once deployed to a public Cloudflare URL where personal health/finance data would be world-readable. We need a way to gate access so only Brian can read or mutate his data, without turning a personal tool into a multi-tenant product.

A partial Better Auth + Drizzle scaffold already existed but was abandoned mid-flight:

- `better-auth` and `drizzle-orm` were installed but **not declared in `package.json`** (a clean install would silently drop them).
- `wrangler.jsonc` had **no D1 binding**, so `getDb()` threw at runtime.
- `src/db/schema.ts` was missing the **`user` table** Better Auth requires, and date columns were plain integers rather than drizzle timestamp-mode.
- `src/server/db.ts` was `@ts-nocheck` and contained half-finished domain CRUD helpers that **duplicated the live R2 store**, implying a second source of truth for domain data.
- No UI ever invoked the auth handler — it was dead code.

The grilling question that drove this ADR: **"Where does authentication state live, and does adopting a relational store for auth mean migrating domain data off R2?"**

## Decision

Adopt **Better Auth with Google OAuth**, backed by **Cloudflare D1 (SQLite) for auth state only**. Domain data stays in **R2** (ADR-001/003). The two stores have strictly separate concerns.

### 1. Store boundaries
- **D1 (`DB` binding)** persists exactly four Better Auth tables: `user`, `session`, `account`, `verification`. Nothing else.
- **R2** remains the system of record for all domain aggregates (nutrition, tasks, finance, plans, workouts, voice/AI logs).
- `src/server/db.ts` is reduced to `getDb()` + `ensureSchema()` and exposes no domain CRUD, removing the competing-store ambiguity.

### 2. Schema bootstrap
- `ensureSchema()` runs idempotent `CREATE TABLE IF NOT EXISTS` statements before auth handling. For a single-user app this is simpler and more reliable than a separate migration step/CLI.
- Schema property names match Better Auth field names (`emailVerified`, `userId`, `expiresAt`) so the drizzle adapter maps correctly. Date columns use `{ mode: "timestamp" }`; `emailVerified` uses `{ mode: "boolean" }`.

### 3. Provider & configuration
- Google is the sole social provider. If `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are absent, `socialProviders` is empty and the app still boots — sign-in simply reports it is unavailable rather than crashing.
- Secrets resolve from Cloudflare Workers env first, then `process.env`, then `globalThis`. A dev-only insecure secret is used outside production.
- `BETTER_AUTH_URL` / trusted origins include localhost + the configured public URL.

### 4. Request flow
- Catch-all server route `/api/auth/$` calls `ensureSchema()` then delegates `GET`/`POST` to `betterAuth().handler(request)`.
- Client uses `better-auth/react` (`signIn.social`, `signOut`, `useSession`) via `src/lib/auth-client.ts`.
- A compact `AuthControl` in the root header shows Sign in (signed out) or avatar + Sign out (signed in), degrading gracefully when OAuth is unconfigured.

### 5. Access scope (v1)
- Single permitted user. v1 does **not** yet hard-gate every route/server-fn behind a session check; the immediate goal is to make auth correct, reproducible, and runnable. Route/server-fn enforcement is a tracked follow-up (see Open Questions).

## Consequences

**Positive**
- Reproducible installs (deps declared) and a runnable auth path (D1 binding present, `user` table created).
- Clear separation of concerns: D1 = identity, R2 = domain. No accidental second source of truth.
- Graceful degradation keeps local/dev flows unblocked without OAuth credentials.

**Negative**
- Two persistence technologies (D1 + R2) increase operational surface (two bindings, two mental models).
- `ensureSchema()` on the auth path adds a tiny per-cold-start cost (idempotent table checks).
- A real remote deploy still requires `wrangler d1 create` + pasting the database id and configuring Google OAuth — documented but manual.

**Risks & Mitigations**
- *D1 binding missing in an environment* → `getDb()` throws an actionable message; `ensureSchema()` is a no-op when unbound so non-auth paths never crash.
- *Schema drift between drizzle model and raw `CREATE TABLE`* → both live in this repo and are reviewed together; column names/types kept in lockstep.
- *Single-user assumption leaking* → `USER_ID` remains the R2 partition; if multi-user is ever needed, the session `userId` becomes the partition key (large change, explicitly out of scope).

## Alternatives Considered

1. **Cloudflare Access (zero-app-code auth)** — Offload auth entirely to Cloudflare Access in front of the Worker. Simplest possible, no tables. Rejected for v1 because it couples the app to a specific deployment posture and complicates local dev; revisit if app-level auth proves heavy.
2. **Migrate all domain data to D1** — Use the relational store everywhere and retire R2. Rejected: R2 aggregates (ADR-003) already work, and a migration is high-risk with no current payoff. Auth needs a relational/queryable store; domain data does not.
3. **Roll-your-own session cookie** — Minimal dependency footprint. Rejected: OAuth, CSRF, session rotation, and rate limiting are easy to get wrong; Better Auth provides them.
4. **Email/password instead of Google** — Avoids an external IdP. Rejected for a personal app where a Google account already exists; Google is lower-friction and more secure than managing password hashes.

## Open Questions / Next Steps

1. **Hard-gate enforcement**: add a session check helper and apply it to mutating server functions + non-public routes. (Tracked.)
2. **Secrets management**: document/automate setting `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` as Worker secrets for prod.
3. **D1 provisioning**: replace the placeholder `database_id` in `wrangler.jsonc` after `wrangler d1 create assistant-db`.
4. **R2 partitioning**: if auth ever maps to multiple users, switch the R2 prefix from the fixed `brian` to the session `userId`.
