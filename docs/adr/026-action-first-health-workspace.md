# ADR-026: Action-First Health Workspace

**Status**: Accepted
**Date**: 2026-07-15
**Deciders**: Brian Kimball

## Context

Compass already records personal nutrition and workout data, proposes workouts, and selects a cross-domain next-best action on Today. Health information is currently distributed across domain routes, which makes the member interpret several metrics before deciding what to do next.

The Health workspace should answer a narrower question: **what is the most useful health action I can take today?** It must unify existing workout and nutrition capabilities without creating a second source of truth, leaking personal health data into household scope, or making medical claims.

## Decision

### 1. Personal-scoped, today-only `/health`

Create `/health` as the top-level Health workspace. Its overview is personal-scoped under ADR-017 and represents the authenticated member's current local day only.

- The route derives today using the established member-local date helpers and `HOUSEHOLD_TIMEZONE` server behavior.
- `/health` does not accept arbitrary historical or future date selection.
- Historical analysis remains in Review/Trends, while detailed workout and nutrition records remain in their existing domain routes.
- Health data is never read from or written to household scope.

### 2. Deterministic `selectNextHealthAction`

Add a pure, deterministic `selectNextHealthAction` selector that chooses one explainable action from existing current-day health context. Inputs may include the member's profile and goals, today's nutrition and hydration progress, planned workout and completion state, recent relevant workout context, and recorded recommendation outcomes.

The selector returns a stable action identity plus the minimum presentation and execution metadata required by the route, including a title, reason, action kind, destination or quick-log action, and completion context. Priority rules are explicit and unit-tested. Selection never requires an LLM or `GROK_API_KEY`.

AI may improve explanatory copy when available, but it may not be required to select, display, execute, or complete the action.

### 3. Shared quick-logging capability

Health reuses the same quick-logging components and domain mutation paths used by Today and the detailed workout/nutrition routes. “Shared” means shared implementation, validation, and behavior—not household data scope.

Quick logging supports only established health mutations, such as recording hydration, food/nutrition, or workout completion. It must not create a parallel Health aggregate or duplicate write logic. Successful mutations refresh the Health context and re-run the deterministic selector.

### 4. `health-next-action` outcomes

Interactions with the selected action record personal-scoped recommendation outcomes using the stable source/type `health-next-action`. Supported states follow the existing recommendation-outcome model, including accepted, dismissed, snoozed, and completed, with optional helpfulness where the existing flow permits it.

Outcomes preserve stable action identity and any existing linkage to the resulting domain record. They are append-only feedback/audit events and are not a replacement for nutrition logs, workout sessions, or profile facts.

### 5. Contextual calls to action

The primary CTA is determined by the selected action rather than by a universal Health button. It may:

- open an inline quick-log flow;
- continue or complete an existing workout flow;
- navigate to the relevant workout or nutrition route;
- expose a safe short/minimum alternative already supported by the workout plan;
- mark a recommendation state when no additional domain input is required.

CTA labels describe the immediate result. Disabled, loading, success, and error states must be explicit, and destructive or replacing actions retain their established confirmation requirements.

### 6. Completion context and minimal validated route handoff

An action is completed only when its required domain evidence exists—for example, a validated quick log or a persisted workout session—not merely because the member opened another route.

When execution belongs on a detailed route, Health passes only the minimal validated handoff needed to restore context, such as a stable plan/action identifier and an allowed operation or section. The destination validates the handoff against current personal-scoped data before presenting or applying it. The handoff must not contain trusted health records, free-form executable instructions, cross-member identifiers, or a duplicate payload that can drift from persistence.

Navigation alone may record acceptance, but completion is recorded after the destination confirms the corresponding persisted result and links it back to the originating `health-next-action` where supported.

### 7. Deterministic fallback and non-medical boundaries

The workspace remains useful with no AI provider, incomplete profile data, or no qualifying action. Deterministic fallback behavior presents a safe established action or an honest current-state message; it does not fabricate goals, diagnoses, contraindications, or completed activity.

Health coaching is general wellness and behavior support. It must not diagnose conditions, interpret symptoms as medical findings, prescribe treatment, recommend medication changes, or override injury/pain restrictions. Concerning symptoms, acute pain, or other red-flag inputs direct the member to appropriate professional or emergency care rather than producing a workout or nutrition directive.

## Consequences

**Positive**

- Health becomes action-oriented instead of another metrics dashboard.
- One deterministic selector provides explainable behavior with or without Grok.
- Reused quick logging and existing domain writes avoid duplicate health records.
- Stable outcomes connect recommendation, action, completion, and later learning.
- Minimal validated handoff preserves route ownership and limits stale or untrusted state.

**Negative**

- Today-only scope intentionally excludes historical browsing from the Health overview.
- Priority rules will require tuning as real outcome data accumulates.
- Completion linkage across routes adds coordination between recommendation outcomes and existing domain records.
- Incomplete data may produce a conservative fallback rather than a highly personalized action.

## Security and privacy

All Health inputs, selector context, quick logs, handoffs, and `health-next-action` outcomes are personal-scoped. Shared UI components must resolve the active member through the established scoped server-function path. No personal nutrition, hydration, workout, injury, pain, profile, or outcome data may enter household storage or another member's route context.

## Alternatives considered

- **Make Health a historical dashboard** — rejected because Review/Trends owns retrospective analysis and the approved workspace is today/action focused.
- **Generate the next action with an LLM** — rejected because selection would become slower, less testable, provider-dependent, and harder to constrain safely.
- **Create Health-specific logging endpoints or storage** — rejected because it duplicates established nutrition and workout mutation paths.
- **Treat route navigation as completion** — rejected because opening a page is not evidence that the health action occurred.
- **Pass the full action or health payload between routes** — rejected because it can become stale, bypass destination validation, and increase privacy risk.
- **Provide diagnostic or treatment guidance** — rejected as outside Compass's wellness-coaching scope.

## Validation

- Unit tests cover `selectNextHealthAction` priority, stable identity, completed-state exclusion, incomplete inputs, no-action behavior, and deterministic output without `GROK_API_KEY`.
- `/health` always resolves the authenticated member's current local day and rejects or ignores attempts to select another date.
- Quick logs use existing validated nutrition/workout mutations, persist once, reload correctly, and never write to household scope.
- Accepted, dismissed, snoozed, and completed interactions append correctly linked personal `health-next-action` outcomes.
- Contextual CTAs expose correct loading/error/success states and reselect after a successful mutation.
- Route handoffs accept only allowlisted minimal fields, validate personal ownership/current state at the destination, and record completion only after persisted domain evidence exists.
- Deterministic fallback works with no AI configuration and medical-boundary/red-flag cases do not produce diagnostic or treatment instructions.
- Keyboard, screen-reader, focus, and mobile interaction flows are manually verified.
- `npm run check`, `npm run test`, and `npm run build` pass when the workspace is implemented.
