# AGENTS.md - Personal Life Improvement Assistant

## Project Mission

Build a personal AI assistant and Life Coach that improves the user's life through:

- Physical fitness (workouts, planning, tracking)
- Nutrition (meal tracking, food logging, suggestions)
- Family care
- Financial growth (stock suggestions, finance advice)
- Productivity (existing kanban, todos)
- Voice-first interaction

**Current user**: Brian Kimball (primary person to improve)

## User Defaults

- Brian is in the United States. Use US customary units in all user-facing health and fitness copy by default: pounds for bodyweight and exercise loads, inches/feet for height, and fluid ounces for hydration.
- Internal storage may preserve existing normalized fields (for example centimeters or milliliters) when needed for compatibility, but UI labels, coach prompts, examples, and voice confirmations should speak in USA units unless the user explicitly chooses otherwise.

## Core Principles

1. **Person-first**: Every feature must demonstrably improve the user's life
2. **AI-friendly docs**: All documentation must be structured for agent consumption
3. **Voice-native**: Primary interaction via voice
4. **Privacy-first**: User data stays local or encrypted
5. **Actionable suggestions**: AI doesn't just track—it recommends and plans

## Tech Stack

- TanStack Start (React + SSR) deployed on Cloudflare Workers + Pages
- Cloudflare R2 as primary persistent data store (user-scoped objects)
- TanStack DB for reactive client-side state only
- TanStack AI + TanStack AI React for AI features
- Grok API (xAI) as primary LLM (server-side via Workers)
- shadcn/ui + Tailwind for UI
- Vite+ (unified Vite 8 toolchain via `vp`) for dev, build, test, check + Vite for core bundling

See `docs/adr/001-cloudflare-r2-deployment.md` for deployment architecture.

## Current State

- Basic TanStack Start app with routing
- Voice input/output system (ADR-004 implemented: browser STT, intent extraction, immediate execution for additive actions, confirmation for destructive, R2 per-object + daily logs)
- Unified Daily Improvement Dashboard (ADR-005) as default `/` route: date nav, progress rings (focus + nutrition), sections for tasks/nutrition/plan/activity, persistent mic FAB + listening overlay, read-only past days, TanStack DB reactivity, zero extra LLM cost for headline
- Productivity uses unified Daily aggregates + legacy todo shim still present during transition
- AI Coach module (`src/server/coach.ts`, ADR-011): `generateCoaching` produces cross-domain suggestions (focus/fitness/nutrition/finance/family) + a daily workout suggestion + motivational headline; `generateWeeklyNarrative` does the weekly version. Grok-backed with a data-driven deterministic fallback (works with no API key). Suggestions persist into the DailyPlan so reloads are free.
- Personalization (ADR-013): a long-lived `UserProfile` (`loadUserProfile`/`saveUserProfile`, stored at `user-profile.json`) and a trailing 7-day `TrendSignals` (`collectTrend`) now feed the coach. Suggestions respect injuries/dietary restrictions, use the user's own protein/water/savings targets, and reference momentum (protein direction, workouts vs. target, net-worth change). The weekly workout plan blends traditional strength, bodyweight calisthenics, and yoga/mobility (sequenced so overlapping muscle areas never land on back-to-back days); `preferredWorkoutStyles` on the profile lets the user steer that blend, defaulting to the balanced mix. All fields optional → empty profile degrades gracefully. `/profile` provides settings/onboarding with a coach-quality completeness indicator.
- Finance is first-class (ADR-012): `loadDailyFinance`/`saveDailyFinance` daily aggregates + a net-worth snapshot on the dashboard (no longer "optional").
- Personal Finance Hub (ADR-016): a tabbed `/finance` route (Overview / Budget / Subscriptions / Investments / Grow) built on `src/server/finance.ts`. Ingestion is manual + CSV statement import (no paid aggregator, no stored bank credentials) with a no-dependency CSV parser, keyword categorizer + learned overrides (`category-rules.json`), and de-dupe. Adds `Budget` (`budget.json`, 50/30/20) and `Subscription` (`subscriptions.json`, with recurring-charge detection) domain types, plus `categoryGroup` on `Transaction`. `generateFinanceAdvice` is a finance-specific advisor (budget/subscriptions/investing/earn-more) — Grok-backed with a deterministic fallback — whose recommendations accept into real tasks via `acceptFinanceActions` (closed loop). Investing output is educational, never executes trades.
- Closed-loop coaching (ADR-014): coach suggestions can be accepted into real daily tasks, voice meal logs parse explicit macros/calories instead of storing zeroes, workout sessions track duration/effort hooks, finance has a lightweight `transactions.json` cashflow ledger, analytics charts cashflow, and weekly review can schedule next-week focus tasks.
- Authentication (ADR-010): Better Auth + Google OAuth backed by Cloudflare D1 (auth tables only — domain data stays on R2), with login restricted to `briankimball1982@gmail.com` and `sophiamkimball@gmail.com` by default. `AuthControl` in the header; degrades gracefully when OAuth is unconfigured. Remote deploy needs a real D1 id + Google secrets.
- Server module layout (ADR-015): route-facing server functions live under `src/server/*`; plain domain operations live in `src/server/domain-impl.ts`; domain persistence goes through `src/server/store.ts`; Cloudflare/API integrations live under `src/server/adapters/*`; client-safe shared types/helpers remain under `src/lib/*`.
- Weekly Review (`/weekly`) and Analytics (`/analytics`) are built on R2 daily aggregates (weekly rollup + editable review + AI narrative; multi-day trend charts).
- Icons standardized on `lucide-react` (emoji/unicode glyphs removed from dashboard, Kanban, and nav).
- Installable PWA: branded web app manifest (`public/manifest.json`), maskable icons, app shortcuts, and a conservative service worker (`public/sw.js`) — network-first for HTML navigations with an offline fallback (`public/offline.html`), cache-first for content-hashed static assets, and never touching `/api`/server-function traffic so user data is never served stale. The SW registers in production only (skipped in dev to avoid fighting Vite HMR); manifest/PWA/theme-color meta is wired in `src/routes/__root.tsx`.
- Theme toggle, basic UI components

## Priority Features (in order)

1. Voice input/output system (implemented ADR-004)
2. Unified daily/weekly improvement dashboard (implemented ADR-005 — current default view)
3. Workout tracking + AI-suggested plans
4. Meal/food logging + nutrition suggestions
5. Finance tracker + stock/finance AI advisor
6. Family task/care coordination
7. Nightly reflection + weekly review (ADR-006/007)

## Documentation Standards for Agents

- All ADRs go in `docs/adr/`
- Domain models and agent context go in `docs/ai/`
- Human-facing docs go in `docs/`
- Handoff documents go in `docs/handoffs/`
- Every feature must have an ADR before implementation
- Code must be self-documenting with clear types
- Agent-readable comments only when logic is non-obvious

## AI Integration Rules

- AI calls are encapsulated behind server functions (`src/server/coach.ts`, `src/server/domain.ts`); migrating the direct Grok transport to TanStack AI abstractions is the target (see ADR-011)
- Every AI path must have a deterministic fallback so the app works with no `GROK_API_KEY`
- Grok API keys stored securely (never committed)
- Responses must be actionable (plans, suggestions, not just data)
- Voice transcription → structured intent → action

## Contribution Rules for Agents

- Never add features that don't directly improve the user's life
- Always update AGENTS.md when architecture changes
- Create ADR for every new major domain
- Prefer TanStack ecosystem solutions
