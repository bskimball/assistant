# Glossary — Personal Life-Improvement Assistant

This glossary defines the canonical terms used across ADRs, code, and AI prompts. All agents and developers must use these terms exactly.

## Core Entities

**User**

- The single root identity (Brian Kimball). All data is partitioned under the user's R2 prefix. No multi-tenant support in v1.

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

- Daily roll-up of accounts, positions, and net worth.

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

**Last updated**: 2026-06-22 (ADR-005 implemented: Unified Daily Improvement Dashboard as default route. Progress rings + headline (focus/protein/recent voice note), date navigation + URL state, TanStack DB collections for daily aggregates, persistent mic FAB + listening overlay, read-only past days, loads daily snapshots + activity from R2, no extra LLM calls. ADR-004 voice fully wired in. AGENTS.md priorities updated.)

**R2 paths for voice (ADR-004)**:
- `assistant/brian/ai/transcripts/{id}.json`
- `assistant/brian/ai/interactions/{id}.json`
