# ADR-021: Forward-Looking Household Finance Guidance

**Status**: Accepted
**Date**: 2026-07-12
**Deciders**: Brian Kimball

## Context

The Finance Hub records household transactions, balances, budgets, subscriptions, and projections, but the primary daily question remains difficult to answer: **how much can the household safely spend before the end of the current month?** Historical cash flow and net worth alone are not actionable enough.

## Decision

### 1. Household-scoped derived guidance

Add a deterministic `SafeToSpendResult` derived from the existing household finance payload. It is never persisted as personal data. Inputs are the configured monthly take-home amount, budget targets, current-month transactions, active recurring commitments, and the requested date.

The first release defines:

- `remainingAfterCommitted`: take-home minus plan spending, remaining recurring commitments, and excluded one-time spending;
- `savingsReserve`: the still-unmet configured savings allocation;
- `safeToSpendThisMonth`: `max(0, remainingAfterCommitted - savingsReserve)`;
- `safeToSpendPerDay`: the monthly safe amount divided by the remaining calendar days, including the requested day;
- a status of `unavailable`, `on-track`, `tight`, or `over-plan`, plus a short deterministic explanation.

The result is a **budget guardrail**, not an account-balance guarantee. The UI must label it accordingly and must not treat net worth, investments, or debt capacity as spendable cash.

### 2. Reuse existing finance math

The calculation lives in `src/lib/finance-math.ts` and composes `buildBudgetInsight`. `loadFinanceHubImpl` adds the result to `FinanceHubPayload` so Today and Finance consume one definition. No new endpoint or store is introduced.

### 3. Future phases

Later releases may add a dated cash-flow calendar, payday-aware balance floor, transaction review inbox, goal funding, and net-worth movement explanations. These remain derived from household-scoped finance data and must work without an LLM.

## Consequences

**Positive**

- The household receives an immediately actionable spending guardrail.
- Today and Finance use one tested calculation.
- No migration or new persistence is required.

**Negative**

- The first release is monthly-budget based and does not know exact payday timing or pending bank transactions.
- Accuracy depends on configured take-home pay, recurring commitments, and transaction categorization.

## Security and privacy

Finance remains household-scoped under ADR-017. No personal health, nutrition, workout, profile, chat, or coach-memory data may enter this calculation.

## Validation

- Unit tests cover missing budget, remaining recurring commitments, savings reserve, negative headroom, and per-day calculation.
- Finance Hub and Today render the same result.
- `npm run check`, `npm run test`, and `npm run build` pass.
