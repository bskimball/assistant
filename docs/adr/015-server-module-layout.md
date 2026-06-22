# ADR-015: Consolidate Server Modules Under `src/server`

**Status**: Accepted
**Date**: 2026-06-22
**Deciders**: Brian Kimball

## Context

The codebase had two server-shaped roots:

- `src/server/*` contained low-level Cloudflare access modules (`r2.ts`, `db.ts`).
- `src/lib/server/*` contained the route-facing server functions and server-side domain logic (`domain.ts`, `coach.ts`, `todos.ts`).

That split made the module interface shallow. Routes imported `src/lib/server/*`, domain logic dynamically imported `src/server/r2.ts`, auth imported `src/server/db.ts`, and docs had to explain which "server" folder meant application logic versus adapter logic. The folder layout also obscured the ADR-010 persistence seam: D1 is auth-only, while R2 remains the domain data store.

## Decision

Use `src/server` as the single server application module.

- Server functions and server-side domain logic live at `src/server/*.ts`.
- Cloudflare-specific implementations live under `src/server/adapters/*`.
- R2 key construction remains centralized in `src/server/adapters/r2.ts` per ADR-003.
- D1/Better Auth access remains auth-only in `src/server/adapters/d1.ts` per ADR-010.
- Client-safe shared types and helpers remain under `src/lib/*`.

## Consequences

**Positive**

- One server root makes imports and ownership easier for agents to navigate.
- Adapter modules now visibly sit behind the R2/D1 seams established by existing ADRs.
- Route modules import the server-function interface from `src/server/*` instead of a second server-like folder.
- Future extraction of store or AI client interfaces has a natural home under `src/server`.

**Negative**

- Existing handoff notes and ADRs need path updates from the old layout.
- Git history shows file moves, so short-term diffs are larger than a logic-only change.

## Next Steps

1. Split the large `src/server/domain.ts` into deeper domain modules once behavior is covered by tests.
2. Introduce a domain store interface so R2 key mechanics stop leaking into domain implementations.
3. Move Grok transport behind a server AI adapter before migrating to TanStack AI.
