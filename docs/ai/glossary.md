# Glossary — Personal Life-Improvement Assistant

This glossary defines the canonical terms used across ADRs, code, and AI prompts. All agents and developers must use these terms exactly.

## Core Entities

**User**

- The single root identity (Brian Kimball). All data is partitioned under the user's R2 prefix. No multi-tenant support in v1.

**UserProfile**

- Long-lived personalization context for the Coach Engine (ADR-013). Optional fields across all four advisor lenses: identity (birthDate/sex/height/units/timezone), coaching (goals, activityLevel), fitness (injuries, trainingDaysPerWeek, equipmentAccess), nutrition (dietaryRestrictions, protein/calorie/water targets), finance (riskTolerance, monthlySavingsGoal, financeNotes). Stored as a single reference object `assistant/brian/user-profile.json` (not a daily aggregate). Every field is optional; an empty profile degrades gracefully.

**WorkoutPlan**

- An AI-generated or manually created plan containing exercises, sets, reps, and goal alignment. Status machine: `draft` → `active` → `archived`. Invariant: only one `active` plan per user at any time.

**WorkoutSession**

- A recorded instance of a workout that was actually performed. Must have a `performedAt` date in the past or present. Invariant: cannot be logged for a future date.

**ExerciseLibrary**

- Canonical exercise definitions (name, movement pattern, equipment) plus user overrides (custom names, notes).

**DailyNutrition**

- The primary nutrition aggregate object for a single calendar day. Contains all `MealLog`s, totals, macros, and water intake. Primary read surface for nutrition AI suggestions.

**MealLog**

- A timestamped meal containing one or more `FoodItem`s. Invariant: must contain at least one `FoodItem`.

**FoodItem**

- A food or ingredient with macros per 100 g. Source is either canonical (OpenFoodFacts) or user-created.

**DailyFinanceSnapshot**

- Daily roll-up of accounts, positions, and net worth. First-class daily aggregate (ADR-012): persisted at `daily-finance/{date}.json`, included in the dashboard payload, with `netWorth` derived server-side from accounts + positions when not explicitly set.

**Transaction**

- Individual financial event (buy, sell, transfer, dividend, etc.).

**ProductivityTask**

- Unified task entity that replaces the original `Todo` and kanban items. Supports status, due date, tags, kanban column, and optional link to a `DailyPlan`.

**DailyFocusScore**

- Daily productivity metric: tasks completed, focus minutes, self-reported energy.

**DailyPlan**

- The single source of truth for any given day. References workout, nutrition targets, top `ProductivityTask`s, AI suggestions, and voice notes. Used by the unified improvement dashboard.

**WeeklyReview**

- End-of-week reflection object: wins, blockers, next-week focus areas.

**AIInteraction**

- Every call to the Grok API is logged as an `AIInteraction`. Stores intent, full prompt, response, tool calls, model version, and token usage. Primary audit and personalization data source.

**VoiceTranscript**

- Audio recording + transcription artifact. Audio stored in R2; text, duration, language, and link to parent `AIInteraction` stored in metadata. Created whenever the user speaks to the assistant.

## Coaching & AI (ADR-011)

**Coach Engine**

- The single server module (`src/lib/server/coach.ts`) that acts as the user's advisory board (life coach + strength coach + financial advisor). Produces a `CoachingResult` from the day's real `DaySignals`. Grok-backed with a deterministic, data-grounded fallback that works with no API key.

**CoachingResult**

- Structured coaching output: a data-aware `headline`, 4–6 `CoachSuggestion`s, and a `WorkoutSuggestion`. Persisted into `DailyPlan.aiSuggestions` so reloads are free.

**TrendSignals**

- The trailing 7-day window the coach reasons over alongside today's snapshot (ADR-013): active days, window-wide task completion %, average protein % of target + days-on-target + direction, average water, workouts performed, and net-worth change. Built from the lighter per-domain loaders (no per-day `.jsonl` reads). Combined with `UserProfile`, this is what makes suggestions personalized and momentum-aware rather than single-day and generic.

**CoachSuggestion**

- One actionable recommendation tagged with a `domain` (`focus | fitness | nutrition | finance | family | general`) and an optional `action` voice-command hint that feeds back into the voice pipeline (ADR-004).

**WorkoutSuggestion**

- An AI- or rotation-generated session (title, focus, estimated minutes, exercises with sets/reps). Completing it logs a `WorkoutSession`.

**WeeklyNarrativeResult**

- Week-level coaching (`reflection / wins / blockers / nextWeekFocus`) generated from pre-computed `WeeklyStatsInput`. Powers the Weekly Review surface.

## Authentication (ADR-010)

**Auth store (D1)**

- Cloudflare D1 (SQLite) persists Better Auth tables only: `user`, `session`, `account`, `verification` (`DB` binding). Domain data stays in R2 — D1 is never a second source of truth for domain state.

## Cross-Cutting Concepts

**Attachment**

- Any binary file (photo of meal, form check video, receipt, etc.) stored in R2 and linked to a domain entity.

**Tag**

- User-defined label that can be applied to tasks, meals, workouts, etc.

**deletedAt**

- Optional timestamp present on every entity. When set, the object is soft-deleted. A nightly worker hard-deletes objects whose `deletedAt` is older than 7 days.

## Invariants (Non-Negotiable)

1. A `WorkoutSession` cannot be logged for a future date.
2. Only one `WorkoutPlan` may have status `active` at any time.
3. A `MealLog` must contain at least one `FoodItem`.

## R2 Storage Conventions (Summary)

**Base prefix**: `assistant/brian/` (via `getUserPrefix()` in `src/server/r2.ts`).

**Daily aggregates** (preferred for nutrition, finance, productivity, planning):

- `assistant/brian/{domain}/{YYYY-MM-DD}.json`
- Examples: `daily-nutrition/2026-06-22.json`, `daily-plan/2026-06-22.json`

**Weekly aggregates**:

- `assistant/brian/{domain}/{YYYY}-W{week}.json`

**Append-only logs** (AI & Voice — never compacted):

- `assistant/brian/{domain}/{YYYY-MM-DD}.jsonl` (or single growing `.jsonl` file for v1)

**Long-lived reference data** (flat, rarely updated):

- `assistant/brian/{collection}.json` (e.g., `exercise-library.json`, `user-preferences.json`)

**Compaction**: Daily aggregates use read-modify-write (full `get` + `put` on every update). Acceptable at personal scale; no separate compaction worker required for v1.

**Deletion**:

- Every object carries optional `deletedAt` (soft delete).
- On soft delete, a record is written to `meta/deleted/{YYYY-MM-DD}.json` (sharded).
- Nightly / periodic worker uses the last ~8 shards to hard-delete keys whose `deletedAt` > 7 days, then prunes processed shards.

---

**Last updated**: 2026-06-22 (ADR-013 implemented: long-lived `UserProfile` + trailing 7-day `TrendSignals` feed the Coach Engine, making suggestions personalized and momentum-aware in both the AI and deterministic-fallback paths. Prior: ADR-010/011/012 — Better Auth + D1 for auth-only (domain stays on R2); AI Coach engine producing cross-domain suggestions + workout/weekly narratives with a zero-config deterministic fallback; first-class Finance Snapshot daily aggregate. Dashboard rebuilt on lucide icons; Weekly Review + Analytics views built on daily aggregates. ADR-005 prior: Unified Daily Improvement Dashboard as default route, progress rings + headline, date nav + URL state, mic FAB. ADR-004 voice wired in.)

**R2 paths for voice (ADR-004)**:

- `assistant/brian/ai/transcripts/{id}.json`
- `assistant/brian/ai/interactions/{id}.json`
