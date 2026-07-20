# AGENTS.md - Personal Life Improvement Assistant

## Project Mission

Build a personal AI assistant and Life Coach that improves each member's life through:

- Physical fitness (workouts, planning, tracking)
- Nutrition (meal tracking, food logging, suggestions)
- Family care / household coordination
- Financial growth (budgeting, bank sync, finance advice)
- Productivity (durable kanban/todos)
- Voice-first interaction

**Users**: Brian Kimball and Sophia Kimball — a household sharing this app.

- **Shared across both**: household finances and shared tasks/todos (see ADR-017).
- **Dedicated per person**: health/nutrition/fitness, profile, coach chat/memory, voice/AI logs, and personal tasks. Never mix one member's health data with the other's.
- Tasks can be personal or shared (`ProductivityTask.shared`).

When adding or changing a domain, decide scope deliberately: per-user vs. household.

## User Defaults

- Both members are in the United States. Use US customary units in all user-facing health and fitness copy by default: pounds for bodyweight and exercise loads, inches/feet for height, fluid ounces for hydration.
- Day keys ("today") are member-local: the browser uses the runtime timezone; on the server (Cloudflare Workers run in UTC) `toISODate`/`todayISO` format in `HOUSEHOLD_TIMEZONE` (`src/lib/domain.ts`, America/New_York) so evenings don't roll into tomorrow. Day arithmetic on ISO date strings must use `addDaysISO` (pure UTC math) — never `new Date(iso + "T00:00:00")` → `toISODate` round trips, which shift a day on the server.
- Internal storage may keep normalized fields (cm, ml) for compatibility, but UI, coach prompts, examples, and voice confirmations should speak in USA units unless the user explicitly chooses otherwise.

## Core Principles

1. **Person-first**: Every feature must improve a member's life and respect per-user vs. household scopes.
2. **AI-friendly docs**: Documentation is structured for agent consumption.
3. **Voice-native**: Primary interaction via voice.
4. **Privacy-first**: Domain data stays on R2 under scoped keys; auth tables only on D1.
5. **Actionable suggestions**: AI recommends and plans; closed loops turn suggestions into real tasks/logs/outcomes.

## Tech Stack

- TanStack Start (React + SSR) on Cloudflare Workers + Pages
- Cloudflare R2 for domain data; Cloudflare D1 for Better Auth tables only
- TanStack DB for reactive client-side state
- Grok API (xAI) as primary LLM via custom server-side transport (`src/server/adapters/ai.ts`); no TanStack AI package installed (see ADR-018)
- Better Auth + Google OAuth + `@better-auth/passkey` (WebAuthn)
- shadcn/ui + Tailwind + `@phosphor-icons/react`
- Vite+ (`vp`) for dev/build/test/check

See `docs/adr/001-cloudflare-r2-deployment.md` for deployment architecture.

## Current State

### App surfaces

- **Daily dashboard** (`/`, ADR-005/023): date nav, progress rings, tasks/nutrition/plan/activity, deterministic next-best-action (overdue-aware), evening check-in on `DailyPlan`, mic FAB + listening overlay, read-only past days.
- **Health workspace** (`/health`, ADR-026): personal, today-first landing with one deterministic next health action + append-only `health-next-action` outcomes; nested `/health/nutrition` and `/health/workouts` for detailed logging/execution. Shared client helpers in `src/lib/health-workflow.ts`.
- **Workouts** (ADR-011/013/022): AI daily/weekly suggestions, progressive overload, readiness/phases/variants (`src/lib/progressive-overload.ts`, `workout-readiness.ts`, `workout-phases.ts`, `workout-variants.ts`). Weekly plans blend strength, calisthenics, and yoga/mobility without stacking the same muscle areas back-to-back; `preferredWorkoutStyles` steers the blend.
- **Nutrition**: meal logging with AI macro estimation (`coach-food-impl.ts`), hydration in fl oz, voice meal logs that parse explicit macros/calories when spoken.
- **Finance hub** (`/finance`, ADR-012/016/019/021): Overview, Budget, Transactions, Recurring/Subscriptions, Investments, Grow. Manual entry + CSV import + SimpleFIN Bridge sync. Shared ledger (`Transaction`, `source: "sync"` for SimpleFIN), categorizer + learned overrides (`category-rules.json`), sealed SimpleFIN access URL (`SIMPLEFIN_SEAL_KEY`), cron in `src/worker-entry.ts`. `generateFinanceAdvice` + `acceptFinanceActions` close the loop; investing output is educational only.
- **Productivity** (`/kanban`, ADR-024): durable open board in `productivity-board.json` (personal + household, CAS) until done/cancelled/deleted; day files `productivity-tasks/{date}.json` archive completed work. Today migrates still-open tasks left in yesterday's day file. `src/server/todos.ts` is a legacy shim only.
- **Coach chat** (`/chat`, ADR-018/020): streaming Grok chat over member context (dashboard + 7-day trend + profile via `src/server/context.ts`), one-tap actions through propose → Apply → `executeVoiceIntentImpl`, personal conversation history (`chat-conversations.json`), coach memories / adaptive profile.
- **Weekly review & analytics** (`/weekly`, `/analytics` under pathless `_review` layout, ADR-006/007/008/023): weekly rollup + editable review + AI narrative; multi-day trends; recommendation effectiveness rollup.
- **Profile** (`/profile`, ADR-013/020): long-lived `UserProfile`, targets, injuries/restrictions, workout-style prefs, coach completeness indicator.
- **Auth** (`/login`, ADR-010/017): Google allowlist (`briankimball1982@gmail.com`, `sophiamkimball@gmail.com` by default) + platform passkeys; `AuthControl` in the header. Local dev degrades without OAuth; production fails closed if auth config is missing.
- **PWA + Compass UI** (ADR-025): `public/manifest.json`, production-only SW (`public/sw.js` — network-first HTML, offline fallback, never caches `/api`/server functions), theme toggle, Phosphor icons.

### AI & closed loops

- **Coach engine** (`src/server/coach.ts` + `coach-*-impl.ts`, ADR-011/013/014/023): cross-domain suggestions, daily workout, weekly narrative; Grok with deterministic structural fallbacks (no API key required). Suggestions persist on `DailyPlan`. Generation learns from recent recommendation outcomes (avoid dismissed/not-helpful; reinforce helpful/completed).
- **Voice** (ADR-004): browser STT → intent extraction → immediate execute for additive actions, confirm for destructive; shared write path with chat actions.
- **Recommendation outcomes** (ADR-023/026): stable ids, append-only personal outcomes (`accepted` / `dismissed` / `snoozed` / `completed` + optional helpful flag) for coach, weekly focus, and health next-actions.

### Server architecture

- **Boundary**: route-facing server functions in `src/server/{domain,finance,coach,chat,session,weather,daily-quote,todos}.ts`; domain logic in `*-impl.ts`; persistence via `src/server/store.ts`; integrations in `src/server/adapters/*`; client-safe types/helpers in `src/lib/*`.
- **Scoping** (ADR-017): global `functionMiddleware` (`auth-middleware.ts` in `src/start.ts`) binds user scope via AsyncLocalStorage (`request-context.server.ts`). `getDomainStore()` = personal (`assistant/{userScope}/*`); `getDomainStore({ shared: true })` = household (`assistant/household/*`). Store throws if auth is configured but no scope is bound.
- **Concurrency**: multi-writer collections use optimistic CAS (`updateJSON` → `ref.update` / daily `update`); mutate fns must be pure over input. Do not load → save contended data.
- **Env**: Cloudflare bindings/secrets only through `src/server/env.ts`. Adapters must not parse `.dev.vars`, import `cloudflare:workers` directly, or import Wrangler at runtime.
- **Server fn style**: inferred handlers `async ({ data }) => …`; `requireAuthSession()` takes no arg (uses `getRequest()`), fails closed.
- **CSRF + privacy**: CSRF middleware on server functions; `X-Robots-Tag: noindex, nofollow`; `public/robots.txt` denies crawlers; `workers.dev`/preview URLs disabled in `wrangler.jsonc`.
- **Quality gates**: `npm run check` = format/lint + `tsc --noEmit`; `npm run test`; `npm run build` = check + test + build (Workers Builds); `npm run build:only` skips the gate for local iteration. CI in `.github/workflows/ci.yml`.

### Deploy config (remote)

- Real D1 id; Cloudflare vars: `GOOGLE_CLIENT_ID`, `BETTER_AUTH_URL`, `PUBLIC_APP_URL`
- Worker secrets: `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`; optional `GROK_API_KEY`, `SIMPLEFIN_SEAL_KEY`

## Priority / open gaps

Most core domains above are implemented. Remaining emphasis:

1. Deeper family/household care coordination beyond shared tasks
2. Stronger nightly reflection UX on top of existing review/check-in data
3. Ongoing coach memory quality and closed-loop effectiveness
4. Optional future: TanStack AI abstractions if versions become installable (not current)

## Documentation Standards for Agents

- ADRs: `docs/adr/`
- Domain models / agent context: `docs/ai/`
- Human-facing docs: `docs/`
- Handoffs: `docs/handoffs/` (create when needed)
- New major domains need an ADR before implementation
- Prefer self-documenting types; agent comments only when logic is non-obvious

## AI Integration Rules

- AI calls go through server modules (`coach.ts`, `chat.ts`, `domain.ts`, `finance.ts`) and `adapters/ai.ts` — never from the client with a raw key.
- Every AI path needs a deterministic fallback with no `GROK_API_KEY`. Fallbacks must be general/structural: preserve explicit user facts, safe calculations, or clearly low-confidence results. Do not hardcode one-off domain knowledge (e.g. named-food nutrition) to paper over AI failure; fix the general estimation path. A curated knowledge table needs its own ADR.
- Never commit API keys.
- Responses must be actionable (plans, suggestions, apply-able actions).
- Voice/chat writes share `executeVoiceIntentImpl` — do not duplicate write logic.

## Contribution Rules for Agents

- Never add features that don't directly improve the user's life
- Update this file when architecture changes
- Create an ADR for every new major domain
- Prefer TanStack ecosystem solutions when they fit pinned versions
- Temporary files go in `.tmp/`
- Scope every new data path (personal vs household) and use CAS for multi-writer collections
