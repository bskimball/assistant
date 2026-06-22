# ADR-014: Closed-Loop Coaching and Advisor Actions

**Status**: Accepted
**Date**: 2026-06-22
**Deciders**: Brian Kimball

## Context

The app had strong daily capture and AI suggestions, but too much of the experience still stopped at "here is advice." A life-improvement assistant needs a closed loop:

1. Understand the person and recent trend.
2. Recommend a concrete action.
3. Let the user accept or log the action quickly.
4. Review whether the action happened.
5. Adjust the next recommendation.

The review identified four practical gaps:

- Coach suggestions were passive text instead of accepted daily actions.
- Voice meal logging created zero-macro meals, weakening nutrition advice.
- Finance tracked balances but not cashflow.
- Weekly review summarized the past but did not schedule the next week.

## Decision

Add first-pass closed-loop mechanics across the advisory board.

### 1. Acceptable daily coach plans

`acceptDailyCoachingPlan` converts the current coach suggestions plus today's workout into real `ProductivityTask` entries tagged with `coach-plan`. The `DailyPlan` records `acceptedAt`, accepted task IDs, and top task IDs so the dashboard can distinguish generated advice from an adopted plan.

### 2. Macro-estimated voice meals

Voice `logMeal` now parses explicit macro/calorie numbers from text such as `40g protein chicken` or `600 calorie lunch`. The resulting meal stores estimated macros plus an `estimateConfidence` marker. `saveDailyNutrition` recomputes totals server-side from meal logs so dashboard rings and coach signals are derived from the actual saved meals.

This is not a food database. It is a useful v1 bridge until OpenFoodFacts, barcode scan, saved foods, or photo analysis are added.

### 3. Fitness progression hooks

`WorkoutSession` now stores optional `durationMinutes`, `effortRating`, and `sorenessRating`. Suggested workout completion records duration and effort. The dashboard surfaces recent training frequency and the latest completed session so the user sees progression context rather than a standalone workout card.

### 4. Cashflow ledger

Add a flat personal `transactions.json` reference store plus `loadTransactions`, `saveTransactions`, and `appendTransaction`. The dashboard can log signed cashflow entries, analytics charts daily cashflow, and coach trend signals include weekly net cashflow.

Net worth snapshots remain the v1 source for balances; transactions are a lightweight cashflow layer, not a full accounting system.

### 5. Weekly review schedules next week

The Weekly Review can now convert `nextWeekFocus` lines into Monday planning tasks tagged `weekly-review` and `coach-plan`. This makes reflection operational.

### 6. Session enforcement

Mutating server functions call `requireAuthSession`. In local development, when OAuth is not configured, the guard allows writes so the app remains usable. When auth is configured, requests must carry a Better Auth session. Trusted server-internal calls can compose after the outer request has been checked.

## Consequences

**Positive**

- Advice can become action in one click.
- Nutrition rings are less likely to be nonsense after voice logging.
- Finance coaching can reference cashflow, not only balance snapshots.
- Weekly review produces next-week tasks.
- Session enforcement now covers the main mutation paths before public deploy.

**Negative**

- Macro parsing is intentionally rough and depends on the user speaking numbers.
- Cashflow is manual and does not categorize automatically.
- Workout progression is still descriptive; it does not yet calculate next weights or deloads.
- Route-level read protection is still a separate hardening step if the app becomes multi-user.

## Next Steps

1. Add saved foods and OpenFoodFacts lookup.
2. Add exercise history by movement with previous best, suggested next load, and deload rules.
3. Add recurring income/expense detection and savings-rate calculations.
4. Make accepted coach-plan tasks editable before creation.
5. Add route-level auth redirects once remote OAuth is provisioned.
