# ADR-023: Closed-Loop Daily and Weekly Life Improvement

**Status**: Accepted
**Date**: 2026-07-12
**Deciders**: Brian Kimball

## Context

Compass already generates coaching, accepts plans into tasks, and schedules weekly-review focus items. The remaining gap is prioritization and outcome learning: the member should see one explainable next action, complete a lightweight evening check-in, and let the coach learn whether recommendations were useful.

## Decision

### 1. Deterministic next best action

Today presents one `NextBestAction` derived from current tasks, workout state, nutrition progress, finance guardrails, and time-of-day. It includes a domain, title, reason, and an existing executable destination or action. Deterministic rules run without `GROK_API_KEY`; AI prose may explain but may not be required to select the action.

Priority order favors urgent or overdue commitments, an incomplete adopted top task, a planned workout with a short/minimum fallback, essential nutrition/hydration gaps late in the day, and negative household finance guardrails. The selector must be pure and unit-tested.

### 2. Evening check-in

Add an optional personal-scoped check-in to `DailyPlan`: energy, day rating, a win, friction, and optional note. The weekly review consumes these entries to identify patterns. Check-ins never enter household scope.

### 3. Recommendation outcomes

Introduce stable suggestion/action identifiers and personal-scoped feedback states (`accepted`, `dismissed`, `snoozed`, `completed`, `helpful`, `not-helpful`) only after Phase 1 actions produce stable identifiers. Do not overload `AIInteraction` or `CoachMemory`; those retain audit and durable-fact responsibilities respectively.

### 4. Weekly review remains the action bridge

Weekly focus recommendations continue to create real `ProductivityTask` records. New outcome linkage extends that path rather than introducing a parallel action store. Personal actions default to personal scope; only explicitly shared household actions use `shared: true`.

## Consequences

**Positive**

- The dashboard becomes decision-oriented instead of metric-oriented.
- Advice, action, reflection, and adaptation form a measurable loop.
- Deterministic behavior works without external AI.

**Negative**

- Priority rules require careful tuning and can initially feel simplistic.
- Full feedback attribution is deferred until stable action IDs exist.

## Security and privacy

Personal tasks, check-ins, workout, nutrition, profile, and feedback remain personal. Household finance may affect a member's displayed recommendation, but personal health data must never be written into household finance records or exposed to the other member.

## Validation

- Pure tests cover next-action priority and empty states.
- A saved evening check-in reloads only for the authenticated member.
- Weekly actions continue to create correctly scoped tasks and record `coach-weekly` outcomes.
- Coach generation consumes recent recommendation outcomes (avoid dismissed/not-helpful; reinforce helpful/completed).
- `npm run check`, `npm run test`, and `npm run build` pass.

## Implementation notes (2026-07-12)

- Dashboard wires real overdue (`task.due < selectedDate`) into `selectNextBestAction`.
- Next-best-action and coach suggestions support completed / dismissed / snoozed plus optional helpfulness.
- Evening check-in includes optional `note`.
- Weekly schedule path records accepted outcomes with stable ids and task linkage.
- `src/lib/recommendation-learning.ts` reduces personal outcome history for coach prompts and fallback filtering.
