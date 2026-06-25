# Handoff — Personal Life Assistant (TanStack Start + Cloudflare)

**Date**: 2026-06-22
**Repo**: `C:\Users\bskim\Dev\assistant` (branch `master`)
**Status**: All work below is **uncommitted** in the working tree. `npx tsc --noEmit` passes clean. App has **not** been run this session.

## What this app is

An AI-assisted personal life coach (fitness, nutrition, finance, family, productivity) — voice-first, single-user (Brian). Read `AGENTS.md` (mission/stack/rules) and `docs/ai/glossary.md` (canonical terms) first.

## What was done this session (two phases)

### Phase 1 — Product improvements (user's fixes + advisor-team build)

- Built the **AI Coach engine** `src/server/coach.ts` (`generateCoaching`, `generateWeeklyNarrative`) — Grok-backed with a zero-config deterministic fallback. This is what makes "AI suggestions" and "workout suggestions" real (they were dead/empty before).
- **Finance** made first-class: `loadDailyFinance`/`saveDailyFinance` in `src/server/domain.ts` + a net-worth card on the dashboard (was a collapsed "optional" placeholder).
- **Icons**: replaced all emoji/unicode glyphs with `lucide-react` (dashboard, `kanban.tsx`, root nav). There were never real SVG sprites — that was a misdiagnosis; the issue was emoji-as-icons.
- Rebuilt `src/routes/index.tsx` (coach card, workout card, finance card, lucide icons) and the nav/brand in `src/routes/__root.tsx`.

### Phase 2 — Fixed abandoned WIP + wrote ADRs

- **Auth/D1 was broken WIP**, now correct & runnable: declared missing deps in `package.json` (`better-auth`, `drizzle-orm`); added the `DB` D1 binding to `wrangler.jsonc`; fixed `src/db/schema.ts` (was missing the `user` table Better Auth requires; date cols now timestamp-mode); trimmed `src/server/adapters/d1.ts` to auth-only (removed `@ts-nocheck` + half-stubbed domain CRUD that competed with R2); added `src/components/AuthControl.tsx` (Google sign-in/out) to the header.
- **Decision**: D1 backs **auth only**; all domain data stays in **R2**. Do not migrate domain data to D1.
- Built real **`/weekly`** (rollup + bar chart + editable WeeklyReview + AI narrative) and **`/analytics`** (7/14/30-day trend charts) on top of R2 daily aggregates.

## Key design decisions & ADRs (do not re-derive — read these)

- `docs/adr/010-authentication-and-d1-sessions.md`
- `docs/adr/011-ai-coach-engine.md`
- `docs/adr/012-first-class-finance-snapshot.md`
- Glossary + `AGENTS.md` "Current State" already updated to match.

## Architecture notes for the next agent

- **Domain persistence = R2** via `src/server/adapters/r2.ts` + `src/server/domain.ts` (daily aggregates `assistant/brian/{domain}/{date}.json`). **Auth = D1** via `src/server/adapters/d1.ts` (4 Better Auth tables). Keep these separate.
- Coach output is persisted into `DailyPlan.aiSuggestions` so reloads don't re-call the LLM; regeneration is explicit (Refresh button / finance edit).
- Everything has a deterministic fallback so the app works with **no `GROK_API_KEY`**.

## Open items / recommended next steps (in priority order)

1. **Session enforcement** — ADR-010's top open question. Auth exists but mutating server fns and non-public routes are NOT yet gated behind a session check. Needed before any public deploy.
2. **Verify the app runs** — `vp dev --port 3000` (the Cloudflare Vite plugin emulates D1/R2 locally). Confirm dashboard/weekly/analytics render and the coach fallback produces suggestions.
3. **Provisioning for remote deploy** (manual, documented): set Worker secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`; run `npx wrangler d1 create assistant-db` and paste the id into `wrangler.jsonc` (currently a placeholder).
4. **Nutrition macros** — voice `logMeal` stores 0 macros; wiring OpenFoodFacts would make the protein ring/coach accurate.
5. Migrate coach's direct Grok `fetch` to the TanStack AI abstraction (ADR-011 next step); migrate legacy `todos.json` shim fully.
6. **Commit the work** — nothing is committed yet; user controls commits/pushes.

## Verification done

- `npx tsc --noEmit -p tsconfig.json` → clean. No runtime/browser verification performed.

## Suggested skills for the next session

- **verify** or **run** — to launch the app (`vp dev`) and confirm the new views/coach work in the browser.
- **better-auth-best-practices** / **better-auth-security-best-practices** (`.agents/skills/`) — when implementing session enforcement (item 1).
- **code-review** — review the uncommitted diff for correctness before committing.
- **tanstack-start** / **tanstack-db** (`.agents/skills/`) — reference for route/server-fn and reactivity patterns.

## Sensitive info

None in this doc. No secrets were read or written; OAuth/auth secrets are env/Worker-secret driven (placeholders only in `wrangler.jsonc`).
