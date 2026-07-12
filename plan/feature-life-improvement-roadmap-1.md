---
goal: Implement forward-looking finance, accurate workout execution, and closed-loop life improvement
version: 1.0
date_created: 2026-07-12
last_updated: 2026-07-12
owner: Brian Kimball
status: "In progress"
tags: [feature, finance, fitness, coaching, roadmap]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In_progress-yellow)

Implement the life-improvement roadmap as independently verifiable vertical slices, beginning with a household safe-to-spend guardrail and exercise-level workout completion. Preserve ADR-017 personal/household isolation and deterministic no-AI behavior.

## 1. Requirements & Constraints

- **REQ-001**: Finance must expose a deterministic monthly safe-to-spend amount and per-day guardrail.
- **REQ-002**: Planned workouts must capture actual exercise name, sets, reps, pounds, RPE, duration, effort, soreness, and notes.
- **REQ-003**: Today must eventually present one deterministic next best action.
- **REQ-004**: Weekly recommendations must continue to create real scoped tasks.
- **SEC-001**: Finance data is household-scoped; health, workout, check-in, and feedback data are personal-scoped.
- **CON-001**: Every AI-assisted path must have a deterministic fallback.
- **CON-002**: New multi-writer collection mutations must use optimistic CAS update paths.
- **CON-003**: Use US customary units in user-facing workout copy.
- **PAT-001**: Route-facing server functions remain thin wrappers over plain implementation modules.
- **PAT-002**: Pure calculations live under `src/lib` and receive unit tests.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Ship actionable finance and accurate workout completion using existing domain foundations.

| Task     | Description                                                                                                              | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-001 | Add ADR-021, ADR-022, and ADR-023 and mark ADR-020 Accepted.                                                             | ✅        | 2026-07-12 |
| TASK-002 | Add `SafeToSpendResult` and pure calculation to `src/lib/finance-math.ts`, with tests in `src/lib/finance-math.test.ts`. | ✅        | 2026-07-12 |
| TASK-003 | Add safe-to-spend to `FinanceHubPayload` in `src/server/finance-hub-impl.ts`.                                            | ✅        | 2026-07-12 |
| TASK-004 | Render the shared guardrail in `src/components/finance/overview.tsx` and `src/routes/index.tsx`.                         | ✅        | 2026-07-12 |
| TASK-005 | Extend `PerformedExercise` minimally and add an editable planned-workout completion flow in `src/routes/workouts.tsx`.   | ✅        | 2026-07-12 |
| TASK-006 | Replace workout append load-save with the repository CAS update pattern and add implementation tests.                    | ✅        | 2026-07-12 |
| TASK-007 | Run focused tests, `npm run check`, `npm run test`, and `npm run build`.                                                 | ✅        | 2026-07-12 |

### Implementation Phase 2

- GOAL-002: Make daily guidance closed-loop and resilient to low time or energy.

| Task     | Description                                                                        | Completed | Date |
| -------- | ---------------------------------------------------------------------------------- | --------- | ---- |
| TASK-008 | Add pure deterministic next-best-action selection and tests.                       | completed |      |
| TASK-009 | Add full, short, and minimum workout variants without duplicating session storage. | completed |      |
| TASK-010 | Add a personal evening check-in to `DailyPlan`, server persistence, and Today UI.  | completed |      |
| TASK-011 | Feed check-in patterns into weekly review and preserve task creation behavior.     | completed |      |

### Implementation Phase 3

- GOAL-003: Add adaptive guidance and measurable recommendation outcomes.

| Task     | Description                                                                                | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------ | --------- | ---- |
| TASK-012 | Add readiness inputs and deterministic workout adaptation.                                 |           |      |
| TASK-013 | Add movement history and progressive-overload recommendations with pain/deload safeguards. |           |      |
| TASK-014 | Add payday-aware cash-flow calendar and projected balance floor.                           |           |      |
| TASK-015 | Add stable recommendation IDs and personal-scoped feedback/outcome records.                |           |      |
| TASK-016 | Add monthly effectiveness reporting for accepted/completed/helpful actions.                |           |      |

## 3. Alternatives

- **ALT-001**: One omnibus life-domain model was rejected because finance and health have different scopes and storage boundaries.
- **ALT-002**: LLM-calculated safe-to-spend was rejected because financial guardrails must be deterministic and testable.
- **ALT-003**: A second action store was rejected because accepted coach and weekly actions already become `ProductivityTask` records.

## 4. Dependencies

- **DEP-001**: ADR-014 closed-loop coaching conventions.
- **DEP-002**: ADR-016/019 Finance Hub, transaction ledger, recurring commitments, and SimpleFIN ingestion.
- **DEP-003**: ADR-017 personal versus household scoping and CAS requirements.
- **DEP-004**: Existing workout plans and sessions in `src/lib/domain.ts`.

## 5. Files

- **FILE-001**: `src/lib/finance-math.ts` — pure finance guidance.
- **FILE-002**: `src/lib/finance-math.test.ts` — finance guidance tests.
- **FILE-003**: `src/server/finance-hub-impl.ts` — Finance Hub assembly.
- **FILE-004**: `src/components/finance/overview.tsx` — Finance display.
- **FILE-005**: `src/routes/index.tsx` — Today display and later next action/check-in.
- **FILE-006**: `src/lib/domain.ts` — performed exercise and later check-in types.
- **FILE-007**: `src/routes/workouts.tsx` — workout completion UI.
- **FILE-008**: `src/server/domain-impl.ts` — workout persistence.

## 6. Testing

- **TEST-001**: Safe-to-spend handles missing budget, commitments, savings reserve, over-plan state, and remaining days.
- **TEST-002**: Finance Hub returns the same guardrail consumed by Today and Finance.
- **TEST-003**: Workout actuals and substitutions persist and reload.
- **TEST-004**: Future workout sessions remain rejected.
- **TEST-005**: Personal workout data and household finance data remain isolated.
- **TEST-006**: Full repository check, test, and build gates pass.

## 7. Risks & Assumptions

- **RISK-001**: Monthly safe-to-spend can be mistaken for available bank cash; UI copy must call it a budget guardrail.
- **RISK-002**: Incomplete transaction categorization or recurring setup reduces guidance accuracy.
- **RISK-003**: Workout completion UI can become too slow; default values must be prefilled from the plan.
- **ASSUMPTION-001**: Configured monthly take-home and targets represent the household's intended monthly plan.
- **ASSUMPTION-002**: Existing optional workout fields preserve backward compatibility.

## 8. Related Specifications / Further Reading

- `docs/adr/014-closed-loop-coaching-and-advisor-actions.md`
- `docs/adr/017-multi-user-scoping-and-passkeys.md`
- `docs/adr/021-forward-looking-finance-guidance.md`
- `docs/adr/022-adaptive-workout-execution.md`
- `docs/adr/023-closed-loop-life-improvement.md`
