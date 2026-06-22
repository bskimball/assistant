# ADR-001: Deploy on Cloudflare with R2 as Primary Data Store

**Status**: Accepted  
**Date**: 2026-06-21  
**Deciders**: Brian Kimball

## Context
The app is a personal life-improvement assistant built with TanStack Start. It currently runs locally with TanStack DB (in-memory). Future features require persistent storage for:
- Workout plans & history
- Meal/food logs
- Finance/portfolio data
- Family tasks
- Voice transcripts & AI interactions

We require:
- Zero-ops serverless deployment
- Low latency globally
- Strong privacy (user data never leaves controlled infra)
- Cost-effective at personal scale
- Native support for TanStack Start SSR

Cloudflare offers Workers + Pages + R2 with global edge, zero egress fees, and built-in object storage.

## Decision
Deploy the TanStack Start application to **Cloudflare Workers + Pages** and use **Cloudflare R2** as the primary persistent data store.

- All user data (workouts, meals, finance, tasks, voice) stored as objects in R2 under user-scoped prefixes.
- TanStack DB used only for reactive client-side state; server reads/writes go through R2 via Cloudflare Workers.
- Authentication & sessions handled via Cloudflare Access or simple signed tokens stored in R2.
- All AI calls (Grok) remain server-side through Workers to protect API keys.

## Consequences

**Positive**
- Global low-latency edge deployment for voice & real-time features.
- R2 provides S3-compatible object storage with zero egress cost — ideal for personal media (voice recordings, exports).
- Scales to zero; costs near-zero until meaningful usage.
- Aligns with privacy-first principle: data stays within Cloudflare account under user control.
- TanStack Start has first-class Cloudflare adapter support.

**Negative**
- R2 is eventually consistent; requires careful handling for concurrent writes (e.g., workout logging while AI suggests plan).
- No built-in relational queries; must implement simple indexing or use TanStack DB + periodic R2 sync for complex views.
- Local development requires wrangler + R2 bindings emulation.
- Migration path from local TanStack DB to R2 must be created.

**Risks & Mitigations**
- Consistency: Use optimistic UI + conflict resolution via timestamps/version vectors.
- Query complexity: Keep domain models simple; use folder/key prefix conventions in R2 for "tables".
- Cold starts: Workers + R2 are fast; acceptable for personal assistant use.

## Alternatives Considered
1. **Vercel + Postgres (Neon/Turso)**: Excellent DX but egress fees and relational DB overkill for personal scale. Violates "keep data local/encrypted" preference.
2. **Self-hosted (Docker + SQLite on VPS)**: Operational burden; contradicts zero-ops goal.
3. **IndexedDB only (client-side)**: Loses cross-device sync and server-side AI processing.
4. **Cloudflare D1 (SQLite)**: Attractive but still in beta limits and less suited for binary voice blobs than R2.

**Chosen path** balances simplicity, cost, privacy, and future AI/voice workload.

## Next Steps
- Create ADR-002 for domain models (User, Workout, MealLog, FinanceSnapshot, etc.).
- Prototype R2 binding + TanStack Start Cloudflare deployment.
- Define data schema conventions under `r2://assistant/{userId}/`.
