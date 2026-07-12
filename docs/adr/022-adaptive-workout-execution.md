# ADR-022: Adaptive Workout Execution and Progression

**Status**: Accepted
**Date**: 2026-07-12
**Deciders**: Brian Kimball

## Context

Weekly workout plans are actionable, and `WorkoutSession` already supports actual sets, reps, load, effort, soreness, and duration. The current workout UI, however, records planned exercises as performed without allowing exercise-level actuals or substitutions. This limits progression guidance and makes adherence data less trustworthy.

## Decision

### 1. Exercise-level completion

The planned-workout completion flow becomes an editable review before saving. Each performed exercise can record:

- performed exercise name, allowing a substitution;
- actual sets;
- actual reps;
- actual weight in pounds;
- RPE from 1–10.

The original planned name is retained only when a substitution occurs through optional `plannedName` on `PerformedExercise`. Existing sessions remain valid because all new fields are optional.

### 2. Session feedback

The same completion flow captures duration, session effort, soreness, and notes. Workout data remains personal-scoped.

### 3. Concurrency

Workout session appends must use an optimistic update path rather than load-then-save because sessions may be logged from multiple tabs. Mutators must remain pure because CAS retries are permitted.

### 4. Future phases

Subsequent releases add full/short/minimum plan variants, readiness checks, movement history, deterministic progressive-overload suggestions, deload rules, and pain-aware substitutions. Medical diagnosis is explicitly out of scope.

## Consequences

**Positive**

- Logged performance reflects what actually happened.
- The app gains the data required for useful progressive-overload guidance.
- Existing stored sessions require no migration.

**Negative**

- Planned workout completion requires a small review step instead of one tap.
- RPE and load remain self-reported.

## Security and privacy

All workout plans, sessions, readiness, pain, and progression data are personal-scoped under ADR-017 and may never be written to the household store.

## Validation

- Unit tests cover optional actual fields and future-date rejection.
- Manual verification logs a substituted exercise and changed sets/reps/load/RPE, reloads, and confirms persistence.
- `npm run check`, `npm run test`, and `npm run build` pass.
