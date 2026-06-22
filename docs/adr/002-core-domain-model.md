# ADR-002: Core Domain Model

**Status**: Accepted  
**Date**: 2026-06-22  
**Deciders**: Brian Kimball

## Context

The personal life-improvement assistant requires a unified domain model that supports:

- Workout tracking + AI-suggested plans (priority #1)
- Meal/food logging + nutrition suggestions (priority #2)
- Finance tracking + AI advisor (priority #3)
- Family coordination, productivity, and daily/weekly planning
- Voice-first interaction (priority #6, but must be designed for from day one)
- Privacy-first storage in Cloudflare R2 with soft-delete + hard-delete after 7 days

Existing `Todo` and kanban implementations must be absorbed into the unified model rather than kept as isolated slices.

The model must be:

- Simple enough for daily/weekly aggregate objects in R2
- AI-interaction and voice-transcript aware
- Actionable (every entity supports planning or suggestion features)
- Consistent with the three non-negotiable invariants discovered during design review

## Decision

Adopt the **Core Domain Model v0.3** defined below.

### Root

- `User` — single root (Brian only). Holds preferences, settings, and is the R2 partition key.

### Fitness Aggregate (daily/weekly objects)

- `WorkoutPlan` — AI-generated from user goals. Fields: `status` (`draft` | `active` | `archived`), `generatedBy` (`ai` | `manual`), exercises[], goal alignment, created/activated/archived timestamps. **Invariant**: only one `active` plan at any time.
- `WorkoutSession` — performed workout. **Invariant**: cannot be logged for a future date. Links to optional plan, records volume, RPE, notes, optional voice transcript reference.
- `ExerciseLibrary` — canonical exercises + user overrides.

### Nutrition Aggregate (daily objects)

- `DailyNutrition` — one object per day containing all `MealLog`s, totals, water. Primary query surface for nutrition AI.
- `MealLog` — timestamped, contains one or more `FoodItem`s. **Invariant**: must contain at least one `FoodItem`.
- `FoodItem` — canonical (OpenFoodFacts) or user-created.

### Finance Aggregate (daily objects)

- `DailyFinanceSnapshot` — net worth, accounts, positions.
- `Transaction` — individual buy/sell/transfer events.

### Productivity Aggregate (daily)

- `ProductivityTask` — unified replacement for existing `Todo` + kanban items. Status, due date, tags, optional kanban column, optional link to `DailyPlan`.
- `DailyFocusScore` — tasks completed, focus minutes, energy rating.

### Planning Aggregate (daily/weekly)

- `DailyPlan` — workout ref, nutrition targets, top `ProductivityTask`s, AI suggestions, voice notes.
- `WeeklyReview` — wins, blockers, next-week focus.

### AI & Voice Layer (append-only logs)

- `AIInteraction` — every Grok call: intent, prompt, response, tool calls, model, tokens.
- `VoiceTranscript` — audio blob key in R2, transcribed text, duration, language, link to `AIInteraction`.

### Cross-Cutting

- `Attachment`, `Tag` — reusable.

### Deletion Policy

- Every entity carries optional `deletedAt` timestamp (soft delete).
- Nightly worker hard-deletes objects with `deletedAt` older than 7 days.

## Consequences

**Positive**

- Unified model eliminates data silos; `DailyPlan` becomes the single source of truth for the improvement dashboard.
- Daily/weekly aggregate objects map cleanly to R2 key prefixes and are cheap to read/write.
- AI layer is first-class — every suggestion and voice interaction is auditable and can be used for future personalization.
- Three invariants are explicitly documented and enforceable in code.
- Soft-delete + 7-day hard-delete satisfies both privacy and storage-cost goals.

**Negative**

- Daily aggregate objects require compaction logic when live updates occur inside a day (append-only event log inside the daily object or separate event objects).
- No relational queries; simple prefix-based indexing must be implemented for cross-domain views (e.g., “show all `ProductivityTask`s due today”).
- `WorkoutPlan` generation must enforce the single-active invariant; AI prompt engineering must include this constraint.

**Risks & Mitigations**

- Concurrent voice + AI updates to the same daily object → optimistic UI + timestamp/version-vector conflict resolution (documented in ADR-001).
- Query complexity for the unified dashboard → keep `DailyPlan` as the primary read model; background workers maintain it from domain events.

## Alternatives Considered

1. **Separate micro-models per feature** (workout model, nutrition model, etc.): Rejected. Violates “unified daily/weekly improvement dashboard” requirement and creates integration debt.
2. **Event-sourcing with full event log**: Attractive for auditability but overkill for personal scale and adds complexity to R2 key design.
3. **Client-only IndexedDB + periodic sync**: Loses server-side AI processing and cross-device voice continuity.

**Chosen model** is the minimal set that satisfies all priority features, the three invariants, voice readiness, and R2 storage constraints.

## Next Steps

- Create glossary in `.agents/glossary.md`
- ADR-003: R2 key naming conventions and compaction strategy for daily aggregates
- ADR-004: Voice interaction pipeline (STT → intent → `AIInteraction` → action)
- Prototype `WorkoutPlan` generation flow with the single-active invariant enforced
- Implement soft-delete + 7-day hard-delete worker

---

**Glossary terms introduced by this ADR are recorded in `.agents/glossary.md`.**
