# ADR-016: Personal Finance Hub (Budgeting, Subscriptions, Investments, Growth)

**Status**: Proposed
**Date**: 2026-06-24
**Deciders**: Brian Kimball

## Context

The mission includes "financial growth," and finance is already first-class as a daily snapshot:

- **ADR-012** added `DailyFinanceSnapshot` (`accounts[]`, `positions[]`, derived `netWorth`), R2 persistence (`daily-finance/{date}.json`), and a dashboard net-worth card.
- **ADR-014** added a lightweight cashflow ledger (`transactions.json`, typed `Transaction[]`) charted in analytics, plus cross-domain coach suggestions that already reference real balances.

But the user's financial goals go well past a balance snapshot. The explicit asks:

1. Track budgeting + get budgeting recommendations.
2. Track subscriptions.
3. Track investments (currently `positions[]` exists in the model but is never surfaced).
4. Investment recommendations.
5. Side-hustle recommendations.
6. Net-worth-growth analysis and "earn more money" recommendations.
7. A dedicated page (or pages) for all of this.

Institutions in scope: **Bank of America, M&T Bank, Capital One, Robinhood**, and **ADP** (paycheck + 401k).

### The data-ingestion reality (why no aggregator, and why not "just OAuth")

Every capability above (budget tracking, subscription detection, spend analysis) needs **transaction-level data** from those institutions. Three ways to get it: manual entry, statement-file import, or a paid aggregator (Plaid/Teller/MX).

A natural assumption is "the banks have OAuth, so connect directly for free." This conflates two different things. The OAuth a user sees is the **bank authenticating its own customer** — it is not a public, self-serve OAuth API that an arbitrary third-party app can register against and pull transactions from:

- **BoA, M&T, Capital One** do not offer individual developers a turnkey account/transactions API. Their developer programs (and Capital One's legacy DevExchange/Nessie) are either sandbox-only fake data or gated to vetted, contracted _fintech partners_ — not self-serve for a personal app.
- **Robinhood** has no official public API; the unofficial one violates ToS and is unstable.
- **ADP** APIs are employer/enterprise-gated, not available to an individual.

This is precisely why aggregators exist — they hold the bank partnerships (or screen-scrape) so apps don't have to. There is no free direct-OAuth shortcut behind them. CFPB §1033 ("open banking") is phasing API access in over years and still routes through bank portals / authorized parties, not arbitrary personal apps. **For a single-user personal app in mid-2026, there is no realistic free live-sync path.**

## Decision

Build a **Personal Finance Hub** at `/finance` (single route, tabbed) that elevates the existing finance domain into budgeting, subscriptions, investments, and an AI growth advisor — ingesting data via **manual entry + statement file import (CSV/OFX/QFX)**, with **no paid aggregator and no stored bank credentials**.

### 1. Data ingestion — manual + file import ("hybrid, no third party")

The realistic privacy-first hybrid is manual entry plus user-uploaded statement files. Every in-scope institution supports a download:

| Institution      | Mechanism              | Notes                                                                         |
| ---------------- | ---------------------- | ----------------------------------------------------------------------------- |
| Bank of America  | CSV / QFX(OFX) export  | checking + credit transactions                                                |
| M&T Bank         | CSV / QFX export       | checking transactions                                                         |
| Capital One      | CSV / OFX export       | credit-card transactions (rich subscription signal)                           |
| Robinhood        | CSV transaction export | positions also updatable manually                                             |
| ADP (pay + 401k) | manual entry           | individual export is PDF-only; capture paycheck income + 401k balance by hand |

- A **statement importer** server function accepts an uploaded CSV/OFX, detects the institution/format (or the user picks it), normalizes rows into `Transaction[]`, **de-dupes** against the existing ledger (date + amount + description hash), and auto-categorizes (see §4). Imports are append-and-reconcile, never destructive.
- This keeps the privacy-first principle _stronger_ than an aggregator would: no live bank credentials ever touch the app. Files are parsed server-side and only normalized transactions persist.
- **Future option** (not v1): a paid aggregator behind the same `Transaction` interface if manual+import friction proves too high. Deferred deliberately.

### 2. Page structure — one `/finance` hub with tabs

A single route with shared data load and tabbed sections, consistent with keeping nav clean:

- **Overview / Net Worth** — headline net worth, account balances, net-worth trend, this-month cashflow.
- **Budget** — 50/30/20 view (see §3), spend-vs-plan, category breakdown, import button.
- **Subscriptions** — detected + manual recurring charges, monthly/annual cost, "audit" candidates.
- **Investments** — `positions[]` holdings, allocation breakdown, 401k, contribution context.
- **Grow** — the AI growth advisor (budget fixes, subscription audit, investment moves, side hustles, earn-more), with accept-into-tasks (see §5).

The dashboard finance card stays as the at-a-glance entry point and deep-links into the hub.

### 3. Budgeting model — 50/30/20

Headline methodology is **50/30/20** (Needs / Wants / Savings) computed off take-home pay (ADP paycheck income):

- Each spend category maps to one of `needs | wants | savings`. Transactions roll up into the three buckets; the hub shows actual-vs-target per bucket for the current month.
- A `Budget` record stores monthly take-home, the three target percentages (default 50/30/20, editable), and an optional per-category limit map for power use — so we can layer envelope-style limits later without a model change.
- Recommendations are framed in 50/30/20 terms ("Wants is 38% vs. 30% target — here's the gap and the two biggest categories").

### 4. Data model additions (`src/lib/domain.ts`)

Extend the existing finance domain (additive; existing types unchanged):

- **`Transaction`** gains `categoryGroup?: 'needs' | 'wants' | 'savings' | 'income' | 'transfer'` and keeps free-text `category`. A deterministic categorizer (merchant/keyword rules) assigns these on import; user can override and overrides are remembered (a small `category-rules.json`).
- **`Budget`** (ref object `budget.json`): `monthlyTakeHome`, `targets { needs, wants, savings }`, optional `categoryLimits: Record<string, number>`, `updatedAt`.
- **`Subscription`** (ref object `subscriptions.json`): `name`, `amount`, `cadence: 'monthly' | 'annual' | 'weekly'`, `nextChargeDate?`, `account?`, `category?`, `status: 'active' | 'canceled'`, `source: 'detected' | 'manual'`, `lastSeen?`. A recurring-charge detector scans the ledger for same-merchant, similar-amount, regular-interval charges and proposes subscriptions for confirmation.
- **`Position`** is surfaced (no shape change): holdings list + simple allocation breakdown; 401k represented as an account/position the user updates manually.

All persistence follows ADR-015 (server functions → `domain-impl.ts` → `store.ts`; R2 ref objects under the user scope).

### 5. AI growth advisor — personalized + actionable, closed-loop

A finance-specific advisor prompt (extending ADR-011's coach, feeding ADR-014's closed loop):

- **Inputs**: real balances, positions, this-month cashflow + budget variance, detected subscriptions, `UserProfile` finance fields (`riskTolerance`, `monthlySavingsGoal`, `financeNotes`) and skills/role for side-hustle relevance.
- **Outputs**: budget fixes (which 50/30/20 bucket is off and the levers), a **subscription audit** (unused/duplicate/price-creep candidates with annualized savings), **investment recommendations** (allocation/contribution moves appropriate to risk tolerance — guidance, not trade execution), and **earn-more / side-hustle** ideas grounded in the user's surplus and skills.
- **Closed loop**: recommendations convert into real `ProductivityTask` entries via the existing accept mechanism (tagged e.g. `finance-plan`), so advice becomes tracked action and the weekly review can check follow-through.
- **Deterministic fallback** (per AI Integration Rules): with no `GROK_API_KEY`, the advisor still produces rule-based output (e.g. "Wants over target → top 2 categories", "3 subscriptions unused 60+ days", "surplus > savings goal → increase 401k by X").

### 6. Disclaimers

Investment/earn-more output is **educational guidance, not licensed financial advice**, and the advisor never executes trades or moves money. A standing disclaimer lives on the Grow tab.

## Consequences

**Positive**

- Delivers all seven asks on top of existing scaffolding (snapshot + ledger + coach) rather than a rebuild.
- No paid third party, no stored bank credentials — strengthens the privacy-first posture.
- Budgeting, subscriptions, and growth advice are all grounded in real transaction data once a statement is imported.
- `Transaction` stays the single interface, so a future aggregator can slot in without UI/model churn.

**Negative**

- Statement import is periodic and manual — data is as fresh as the last upload.
- CSV/OFX formats vary by institution; the importer needs per-institution parsing and ongoing maintenance.
- Auto-categorization is heuristic; early accuracy depends on the rule set + user corrections.
- ADP income/401k are hand-entered (low fidelity, depends on the user keeping them current).

**Risks & Mitigations**

- _Importer brittleness across formats_ → start with CSV (simplest, universally exported), add OFX/QFX next; let the user pick institution to disambiguate; fail safe (skip unparseable rows, report them).
- _Duplicate transactions on re-import_ → stable de-dupe hash (date + amount + normalized description + account) and append-only reconcile.
- _Miscategorization skews 50/30/20_ → user overrides persist as rules and improve future imports.
- _Advice liability_ → explicit "educational, not financial advice" framing; no execution; risk-tolerance-gated.

## Alternatives Considered

1. **Paid aggregator (Plaid/Teller/MX) now** — best fidelity + auto-sync, but adds cost, OAuth, and bank-credential PII to a single-user privacy-first app. Rejected for v1; kept as a future drop-in behind `Transaction`.
2. **"Direct bank OAuth, no middleman"** — not actually available to an individual personal app for these institutions (see Context). Not a real option in mid-2026.
3. **Manual entry only** — maximal privacy, minimal tech, but budgeting/subscription detection by hand is tedious enough to kill adoption. Folded in as the manual half of the hybrid; import does the heavy lifting.
4. **Multiple top-level routes** (`/budget`, `/subscriptions`, `/investments`) — more discoverable but heavier nav and repeated data loads. Rejected in favor of one tabbed hub.

## Next Steps (phasing)

1. **Phase 1 — Hub + model**: `/finance` route with tabs, surface existing net worth + positions, add `Budget`/`Subscription` types + persistence, manual entry everywhere.
2. **Phase 2 — Import**: CSV importer (BoA/M&T/Capital One/Robinhood) → normalized `Transaction[]` with de-dupe + deterministic categorizer + 50/30/20 rollup.
3. **Phase 3 — Subscriptions**: recurring-charge detector over the ledger → confirmable subscription registry + audit candidates.
4. **Phase 4 — Growth advisor**: finance-specific advisor prompt + deterministic fallback, closed-loop accept-into-tasks, Grow tab with disclaimer.
5. **Phase 5 (optional/deferred)**: OFX/QFX import; evaluate a paid aggregator only if manual+import friction is high.
