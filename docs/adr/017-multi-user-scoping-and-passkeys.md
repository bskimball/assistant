# ADR-017: Multi-User Data Scoping + Passkey (Fingerprint) Login

**Status**: Proposed
**Date**: 2026-06-27
**Deciders**: Brian Kimball

## Context

Two people now use the app: Brian (`briankimball1982@gmail.com`) and his wife
Sophia (`sophiamkimball@gmail.com`). Login was already restricted to those two
Google accounts (ADR-010), but **all domain data was hardcoded under a single
prefix** — `r2.ts` exported `USER_ID = "brian"`, so every R2 key was
`assistant/brian/...`. Both accounts would therefore silently share _everything_,
including private health logs.

The household model the user asked for:

- **Finances are shared** — both manage them together.
- **Health is personal** — each person has their own workouts and food tracking.
- **Productivity is mixed** — personal tasks plus shared (combined) tasks, in one
  view.
- Aggregate views (dashboard, coach, analytics, profile) are **per-person** but
  still surface the shared finances.

Separately, the app is an installable PWA and the user wants **biometric
(fingerprint) login**.

## Decision

### 1. Two data scopes

- Personal data → `assistant/{userScope}/...` (`brian`, `sophia`).
- Shared data → `assistant/household/...`.
- `resolveUserScope(email)` (`src/lib/scope.ts`) maps the known emails to fixed
  ids; Brian → `brian`, so all his existing personal data stays in place.

**Personal collections:** profile, workout plans/sessions, daily nutrition, daily
plan, focus, weekly review, voice/AI logs, and the personal slice of tasks.
**Shared collections:** transactions, budget, subscriptions, category rules,
daily-finance snapshots, and the shared slice of tasks.

### 2. Request-scoped resolution (no per-call threading)

The R2 key helpers already accepted an optional `userId`. Rather than thread a
scope through ~40 call sites, a global **function** middleware
(`src/server/auth-middleware.ts`, registered as `functionMiddleware` in
`src/start.ts`) resolves the session once and binds the per-user scope into
`AsyncLocalStorage` (`src/server/request-context.ts`; `nodejs_compat` is
enabled). It must be `functionMiddleware`, not `requestMiddleware`: all domain
data access happens inside server functions (including those invoked during
SSR), and only `functionMiddleware` wraps server-function RPC calls. The
middleware uses `getRequest()` to read the active request (with auth cookies),
and dynamically imports server-only deps so `node:async_hooks`/`cloudflare:workers`
never reach the client bundle.

`getDomainStore()` reads that scope for personal data; `getDomainStore({ shared:
true })` selects the household scope. Finance impls and the finance slice of the
dashboard use the shared store; everything else stays personal.

**Anti-leak guard:** if auth is configured but no scope is bound, the store
throws instead of defaulting — one member can never read/write another's data.
Dev with no auth configured binds `brian` (the existing single-user escape
hatch).

### 3. Tasks: personal + shared in one view

`ProductivityTask` gains a `shared` flag. `loadProductivityTasksForDayImpl`
reads both the personal and household daily files and merges them (tagging each
task's origin); `saveProductivityTasksForDayImpl` splits by the flag and writes
each subset to its scope. The Kanban board adds a per-task share toggle, a
"Shared" badge, and an All/Mine/Shared filter; the dashboard shows the badge.
(The legacy `todos.json` shim is unused by the UI and stays personal-scoped.)

### 4. Passkey / WebAuthn

`@better-auth/passkey` layered on the existing Google allowlist (Better Auth +
D1). Server plugin in `auth.ts` (`rpID` derived from the base URL; `origin`
defaults to the request header, so localhost and the prod HTTPS domain both
work). Client plugin in `auth-client.ts`. A `passkey` table is added to the
drizzle schema and the idempotent `ensureSchema()` bootstrap. Users sign in with
Google once, enroll a platform passkey ("Enable fingerprint login" in
`AuthControl`), and afterwards use "Sign in with fingerprint" on `/login`.

### 5. Migration

`migrateFinanceToHousehold` (`src/server/migrate.ts`, exposed at
`/admin/migrate`) idempotently copies Brian's finance collections and
daily-finance snapshots from `assistant/brian/*` to `assistant/household/*`.
Run once, then remove the route + module.

## Consequences

- WebAuthn requires a secure context; `rpID` must match the host. Passkeys are
  per-device, so each person enrolls on each device after a Google sign-in.
- Concurrent edits to shared collections remain last-write-wins (acceptable for
  a two-person household).
- The strict scope guard means any new domain server function automatically
  fails closed if invoked without a bound scope.
