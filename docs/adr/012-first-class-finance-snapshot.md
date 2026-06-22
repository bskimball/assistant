# ADR-012: First-Class Finance Snapshot

**Status**: Accepted
**Date**: 2026-06-22
**Deciders**: Brian Kimball

## Context

Finance was in the domain model (`DailyFinanceSnapshot`, `AccountBalance`, `Position`, `Transaction` — ADR-002) but had **no persistence helpers, no AI involvement, and no real UI**. On the dashboard it was a collapsed `<details>` labelled "Finance snapshot (optional)" that rendered a placeholder string. For an app whose mission includes "financial growth," finance being optional and inert contradicted the product intent.

The grilling questions:

- **"Can you improve what you don't measure?"** Net worth must be visible and trivially updatable.
- **"Where does finance live?"** Consistent with the rest of the domain, or a special case?
- **"Daily snapshot vs. running ledger?"** What's the right granularity for v1?

## Decision

Promote finance to a **first-class daily snapshot**, persisted and surfaced exactly like nutrition and tasks.

### 1. Persistence (R2 daily aggregate)
- Add `loadDailyFinance(date)` / `saveDailyFinance({ date, finance })` server functions following the established daily-aggregate pattern, stored at `assistant/brian/daily-finance/{YYYY-MM-DD}.json` (ADR-003).
- `netWorth` is **derived server-side** from `accounts` + `positions` totals when not explicitly provided, so the headline number can't silently drift from its components.
- Finance is included in the unified `loadDailyDashboard` payload so the dashboard fetches it in one round trip.

### 2. UI (no longer "optional")
- The dashboard shows a **Finance Snapshot** card with net worth as the headline figure, a per-account list, and an inline quick-add (account name + balance) that upserts by name.
- Saving a balance re-runs the AI Coach (ADR-011) so finance advice reflects the new numbers immediately.

### 3. Granularity (v1)
- v1 is a **daily snapshot of balances**, not a full transaction ledger. `positions` and `Transaction` remain in the model for later but are not yet surfaced. This matches personal cadence (update balances occasionally) and keeps the UI light.

## Consequences

**Positive**
- Net worth is visible and one tap to update — the measurement baseline the coach needs.
- Finance uses the same daily-aggregate mechanics as every other domain (no special-casing).
- Coaching becomes genuinely cross-domain: finance suggestions are now grounded in real balances.

**Negative**
- A daily snapshot can't answer "where did the money go" — no transaction history yet.
- Manual balance entry is low-friction but also low-fidelity (no account sync/import).
- Net worth trend across days depends on the user actually updating balances.

**Risks & Mitigations**
- *Stale balances skew trends* → analytics (ADR-008) carries the latest non-zero value forward; coach phrases finance advice around presence/automation rather than precise deltas.
- *Derived vs. provided net worth confusion* → server always recomputes from components unless an explicit override is passed.

## Alternatives Considered

1. **Full transaction ledger now** — Richer (cash-flow, categorization) but far heavier UI + data entry, and overkill before balances are even tracked. Deferred to a future ADR.
2. **Brokerage/bank API sync (Plaid-style)** — Best fidelity, but adds a paid third party, OAuth, and PII handling for a single-user app. Rejected for v1; revisit if manual entry proves too tedious.
3. **Keep finance optional/collapsed** — Lowest effort. Rejected: it contradicts the mission and starved the coach of finance signal.

## Next Steps

1. Add `Transaction` capture + a simple cash-flow view; compute net worth from a running ledger.
2. Surface `positions` (holdings) and basic portfolio breakdown.
3. Finance-specific AI advisor prompt (debt paydown vs. invest, subscription audit) feeding ADR-011.
4. Evaluate an aggregator integration if manual entry friction is high.
