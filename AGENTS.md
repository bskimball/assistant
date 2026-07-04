# AGENTS.md - Personal Life Improvement Assistant

## Project Mission

Build a personal AI assistant and Life Coach that improves each member's life through:

- Physical fitness (workouts, planning, tracking)
- Nutrition (meal tracking, food logging, suggestions)
- Family care
- Financial growth (stock suggestions, finance advice)
- Productivity (existing kanban, todos)
- Voice-first interaction

**Users**: Brian Kimball and Sophia Kimball — a household sharing this app.

- **Shared across both**: household finances and shared tasks/todos (see ADR-017 scoping).
- **Dedicated per person**: nutrition and all other health data (meal/food logging, calorie & macro tracking, fitness, profile) are individual — each member's data is scoped to that person and never mixed. Tasks can be either personal or shared.

When adding or changing a domain, decide its scope deliberately: per-user (health, nutrition, profile) vs. household (finances, shared tasks). See ADR-017 for the scoping mechanism.

## User Defaults

- Both Brian and Sophia are in the United States. Use US customary units in all user-facing health and fitness copy by default: pounds for bodyweight and exercise loads, inches/feet for height, and fluid ounces for hydration.
- Day keys ("today") are member-local: in the browser the runtime timezone is used; on the server (Cloudflare Workers run in UTC) `toISODate`/`todayISO` format in `HOUSEHOLD_TIMEZONE` (`src/lib/domain.ts`, America/New_York) so evenings don't roll into tomorrow. Day arithmetic on ISO date strings must use `addDaysISO` (pure UTC math) — never `new Date(iso + "T00:00:00")` → `toISODate` round trips, which shift a day on the server.
- Internal storage may preserve existing normalized fields (for example centimeters or milliliters) when needed for compatibility, but UI labels, coach prompts, examples, and voice confirmations should speak in USA units unless the user explicitly chooses otherwise.

## Core Principles

1. **Person-first**: Every feature must demonstrably improve a member's life, and must respect per-user vs. household data scopes (never leak one person's health/nutrition data to the other)
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
- Personal Finance Hub (ADR-016/019): a tabbed `/finance` route (Overview / Budget / Subscriptions / Investments / Grow) built on `src/server/finance.ts`. Ingestion supports manual entry, CSV statement import, and SimpleFIN Bridge bank sync. SimpleFIN state lives in shared `simplefin.json` with the access URL sealed by the `SIMPLEFIN_SEAL_KEY` secret; sync logic is plain server code in `src/server/finance-sync.ts`, HTTP/sealing lives in `src/server/adapters/simplefin.ts`, and the Worker cron entry is `src/worker-entry.ts`. Transactions still flow through the single `Transaction` ledger (`source: "sync"` for SimpleFIN) with the existing categorizer + learned overrides (`category-rules.json`), and synced balances write shared daily-finance snapshots with explicit net worth to avoid re-adding manual positions. `generateFinanceAdvice` is a finance-specific advisor (budget/subscriptions/investing/earn-more) — Grok-backed with a deterministic fallback — whose recommendations accept into real tasks via `acceptFinanceActions` (closed loop). Investing output is educational, never executes trades.
- Closed-loop coaching (ADR-014): coach suggestions can be accepted into real daily tasks, voice meal logs parse explicit macros/calories instead of storing zeroes, workout sessions track duration/effort hooks, finance has a lightweight `transactions.json` cashflow ledger, analytics charts cashflow, and weekly review can schedule next-week focus tasks.
- Authentication (ADR-010): Better Auth + Google OAuth backed by Cloudflare D1 (auth tables only — domain data stays on R2), with login restricted to `briankimball1982@gmail.com` and `sophiamkimball@gmail.com` by default. `AuthControl` in the header; local dev degrades gracefully when OAuth is unconfigured, but production fails closed if auth config is missing. Remote deploy needs a real D1 id, Cloudflare variables for non-sensitive config (`GOOGLE_CLIENT_ID`, `BETTER_AUTH_URL`, `PUBLIC_APP_URL`), and Worker secrets for sensitive values (`GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`; optional `GROK_API_KEY`). `wrangler.jsonc` disables `workers.dev` and preview URLs, and responses carry `X-Robots-Tag: noindex, nofollow` with `public/robots.txt` denying crawlers.
- Multi-user scoping + passkeys (ADR-017): two members (Brian, Sophia) with **per-user vs. shared data scopes**. Personal data lives at `assistant/{userScope}/*` (health, profile, personal tasks, voice/AI logs); shared household data at `assistant/household/*` (finances, shared tasks). A global function middleware (`src/server/auth-middleware.ts`, registered as `functionMiddleware` in `src/start.ts` — server functions are the only domain-data access path) resolves the session via `getRequest()` and binds the per-user scope via `AsyncLocalStorage` (`request-context.ts`); `getDomainStore()` is personal, `getDomainStore({ shared: true })` is household. Strict anti-leak guard: the store throws if auth is configured but no scope is bound. `ProductivityTask.shared` splits tasks across scopes — load merges personal+household, save routes by flag; Kanban has a share toggle, "Shared" badge, and All/Mine/Shared filter. **Biometric login** via `@better-auth/passkey` (WebAuthn) layered on the Google allowlist: enroll a platform passkey after Google sign-in (`AuthControl`), then "Sign in with fingerprint" on `/login`; `passkey` D1 table added to `schema.ts` + `ensureSchema()`. (The one-time brian→household finance migration shim and `/admin/migrate` route were removed once verified obsolete — the production bucket never held pre-scoping finance data.)
- Server module layout (ADR-015): route-facing server functions live under `src/server/*`; plain domain operations live in `src/server/domain-impl.ts`; domain persistence goes through `src/server/store.ts`; Cloudflare/API integrations live under `src/server/adapters/*`; client-safe shared types/helpers remain under `src/lib/*`. Pure, unit-tested CSV/statement parsing + categorization helpers live in `src/server/finance-parse.ts`; shared 50/30/20 rollups, recurring reconciliation, and deterministic finance-advice fallback live in `src/lib/finance-math.ts` so server and route code use one implementation. Cloudflare env/binding lookup lives in `src/server/env.ts`; adapters should not parse `.dev.vars`, import `cloudflare:workers` themselves, or import Wrangler at runtime.
- Server functions use inferred typed handlers (`async ({ data }) => …`, no `ctx: any`). Auth checks call `requireAuthSession()` with no argument — it resolves the active Request itself via `getRequest()` and fails closed. Quality gates: `npm run check` = format/lint + `tsc --noEmit`; `npm run build` runs check + tests first (this is what Workers Builds executes, so a failing test blocks the deploy; `npm run build:only` skips the gate for local iteration). CI mirrors it in `.github/workflows/ci.yml`.
- Concurrency: contended R2 collections are mutated via optimistic CAS (`updateJSON` in `adapters/r2.ts` → `ref.update` on the store → `updateTransactionsImpl`/`updateCategoryRulesImpl`/`updateChatConversationsImpl`), which retries on etag conflict so two members/tabs can't drop each other's writes. New mutations of shared or multi-writer collections must use the `update*` path (mutate functions may re-run — keep them pure over their input), not load → save.
- Weekly Review (`/weekly`) and Analytics (`/analytics`) are built on R2 daily aggregates (weekly rollup + editable review + AI narrative; multi-day trend charts).
- Icons standardized on `lucide-react` (emoji/unicode glyphs removed from dashboard, Kanban, and nav).
- Installable PWA: Compass-branded web app manifest (`public/manifest.json`), SVG-first icons with generated PNG fallbacks, app shortcuts, and a conservative service worker (`public/sw.js`) — network-first for HTML navigations with an offline fallback (`public/offline.html`), cache-first for content-hashed static assets, and never touching `/api`/server-function traffic so user data is never served stale. The SW registers in production only (skipped in dev to avoid fighting Vite HMR); manifest/PWA/theme-color meta is wired in `src/routes/__root.tsx`.
- Conversational Coach chat (ADR-018): a top-level `/chat` ("Coach") route — a streaming conversation with Grok that reasons over the member's recorded data (today's dashboard + 7-day trend + profile, assembled by `src/server/context.ts` reusing the coach's `collectTrend`/`profileBlock`) and proposes one-tap actions. Transport is our own SSE (the TanStack AI alpha adapter family is uninstallable on our pinned versions — see ADR-018): `streamChat` in `src/server/adapters/ai.ts` streams xAI's OpenAI-compatible API; `chatStream` is a scope-bound `createServerFn` returning a raw `text/event-stream` Response (domain reads happen in-scope before streaming LLM output). Actions use OpenAI function-calling for _detection_ + a "propose → Apply → scoped write" flow: `applyChatAction` maps a proposed call to a `VoiceIntent` and runs the shared `executeVoiceIntentImpl` (no duplicated write logic). Deterministic fallback streams a data snapshot when no `GROK_API_KEY`. Conversations are **personal-scoped** and persisted (`chat-conversations.json`): the route saves after each turn (`saveChatConversation`), with `loadChatHistory`/`loadChatConversation`/`deleteChatConversation` server fns and pure helpers in `src/lib/chat.ts`. A module-level session cache restores the active transcript instantly on navigation; a History drawer (shadcn `Sheet`) browses/deletes past chats and "New" starts a fresh one.
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
