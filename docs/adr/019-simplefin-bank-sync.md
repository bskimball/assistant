# ADR-019: SimpleFIN Bank Sync (Live Balances & Transactions)

**Status**: Proposed
**Date**: 2026-07-03
**Deciders**: Brian Kimball

## Context

ADR-016 built the Personal Finance Hub on **manual entry + statement file import**, explicitly deferring any aggregator: _"a paid aggregator behind the same `Transaction` interface if manual+import friction proves too high. Deferred deliberately."_ That friction is now real — balances go stale between CSV downloads, the `DailyFinanceSnapshot` net-worth trend only moves when someone remembers to upload, and loan payoff math runs on hand-entered principals.

ADR-016 also correctly ruled out "direct bank OAuth" (not available to individuals) — that analysis stands. What changed is the evaluation of the aggregator tier. A July 2026 comparison of Plaid vs **SimpleFIN Bridge** against the household's actual institutions:

| Institution           | Need                       | SimpleFIN                 | Plaid                                       |
| --------------------- | -------------------------- | ------------------------- | ------------------------------------------- |
| Bank of America       | balances + transactions    | ✅ full                   | ✅ full                                     |
| M&T Bank              | balances + transactions    | ✅ full                   | ✅ full                                     |
| Robinhood             | account value              | ✅ balance + transactions | ✅ + per-position holdings (Investments)    |
| ADP Retirement (401k) | balance                    | ✅ listed (flaky class)   | ✅ listed (flaky class)                     |
| Truist (car loan)     | balance, APR               | ⚠️ balance only           | ⚠️ balance only (Liabilities excludes auto) |
| Rocket Mortgage       | balance, APR, next payment | ⚠️ balance only           | ✅ full mortgage detail                     |

- **SimpleFIN Bridge** (powered by MX): **$15/year flat**, up to 25 institutions, ~daily refresh, ≤24 API requests/day expected. No approval process. Integration is a token + one authenticated GET (accounts, balances, transactions in a single payload). Connection repair happens on _their_ site — zero relink code in the app.
- **Plaid** pay-as-you-go: ~$23+/year for this portfolio via per-Item monthly product fees, **plus** a Production-approval application, US OAuth registration (BofA, M&T, Truist, Robinhood are OAuth institutions), a Link UI flow, token exchange/storage, and update-mode relink handling. Its concrete advantages here reduce to Rocket Mortgage APR/next-payment detail, Robinhood share counts, and real-time (vs daily) balances.

The app's core loop — a **daily** snapshot, loan balances feeding payoff estimates, transactions feeding the 50/30/20 budget — needs exactly daily granularity. Every Plaid-only capability is either cosmetic for this use case or already mitigated (positions are tracked manually with live Yahoo pricing per ADR-016/quotes adapter; loan APRs are a manual field that rarely changes).

One posture question must be faced honestly: ADR-016's "no stored bank credentials" principle. SimpleFIN inverts the risk model — the app never sees bank usernames/passwords (those live at the Bridge, which holds read-only MX connections). What the app stores is a SimpleFIN **Access URL**: a credential granting read-only access to linked-account data. Strictly weaker than bank credentials, but still a secret worth protecting.

## Decision

Adopt **SimpleFIN Bridge** as the live-sync source for the finance hub, behind the existing `Transaction` / `DailyFinanceSnapshot` interfaces, at $15/year. No Plaid.

### 1. Credential handling — setup token in-app, access URL sealed in R2

- A **Connections** section on the finance page accepts a one-time SimpleFIN **Setup Token**. The server claims it (one POST) and receives the permanent **Access URL**.
- The Access URL is persisted in a household-scoped ref object `assistant/household/simplefin.json` — **encrypted at rest** (AES-GCM via WebCrypto) with a `SIMPLEFIN_SEAL_KEY` Workers secret. The R2 object alone is useless without the secret; the secret alone is useless without the object. Honors both ADR-010 (D1 stays auth-only) and the spirit of ADR-016 (no plaintext credentials in the data store).
- The Access URL is **never** sent to the client. Rotation = paste a new setup token; the old Bridge token is revoked on their site.

### 2. Sync engine — daily cron + rate-limited manual refresh

- A **Workers cron trigger** (daily, morning `HOUSEHOLD_TIMEZONE`) runs the sync: one GET to the Access URL fetching all accounts + balances + transactions since the last sync, then persists (§3–§5) and writes the day's `DailyFinanceSnapshot`. Net-worth history accrues with zero human involvement.
- A **"Sync now"** button on the finance page triggers the same path, rate-limited (≥1 h between manual syncs) to stay comfortably inside the ≤24 req/day budget.
- Sync logic lives in `src/server/finance-sync.ts` (plain logic, ADR-015 style) with the HTTP transport in `src/server/adapters/simplefin.ts` — same seam pattern as `adapters/quotes.ts`: timeouts, never throws, partial results degrade gracefully.

### 3. Transaction ingestion — full transactions from a cutover date

- On first successful sync, a **cutover date** (that day) is recorded in `simplefin.json`. Only transactions dated **on/after the cutover** are ingested; pre-cutover CSV history is never touched, eliminating the double-count risk (SimpleFIN txn IDs cannot match existing date+amount+description dedupe hashes).
- Synced rows map to the existing `Transaction` shape with `source: "import"`-equivalent provenance (`source: "sync"` added to the union), `dedupeKey = "sfin:" + <SimpleFIN transaction id>`, and run through the **existing categorizer + category rules** — budget rollups and subscription detection work unchanged.
- CSV import remains for backfill and any account SimpleFIN can't reach. The `Transaction` interface stays the single seam, exactly as ADR-016 planned.

### 4. Account & loan mapping — auto for assets, explicit links for loans

- Synced bank/investment accounts appear in snapshots under their SimpleFIN names via an editable **alias map** in `simplefin.json` (SimpleFIN account id → display name), so existing account-name continuity is one rename away.
- **Loans** (Truist auto, Rocket mortgage): a small linking UI associates a SimpleFIN account with an existing `kind: "loan"` `Subscription`. Each sync then auto-updates that subscription's `balance` (payoff math runs on real principal) while the manual `apr` field stays authoritative — neither provider supplies auto-loan APR, and mortgage APR is effectively constant.
- Unlinked loan-type SimpleFIN accounts are surfaced as suggestions, never auto-created — avoids duplicating the loans already tracked manually.

### 5. Snapshot & net-worth semantics

- The sync writes `DailyFinanceSnapshot.accounts[]` from synced balances (liabilities as **negative** amounts) merged with any manually tracked accounts not covered by SimpleFIN.
- `netWorth` is set **explicitly** by the sync as the sum of account balances. `positions[]` (manual holdings + Yahoo quotes) remain for allocation display but are **not re-added** to net worth when their brokerage account balance is synced — prevents double-counting Robinhood.

### 6. Failure posture

Consistent with every external path in this app: a failed or partial sync (Bridge down, one institution erroring — ADP 401k is the expected offender) keeps last-known balances, stamps per-account `as of` staleness shown in the UI, and never blocks page load or the cron's snapshot write. Sync results (per-account success/failure, counts) are recorded in `simplefin.json` for the Connections UI.

## Consequences

**Positive**

- Live daily numbers across all six institutions for $15/year; the CSV-download chore disappears for covered accounts.
- Net-worth history accrues unattended via cron — the trend chart finally reflects reality.
- Loan payoff estimates run on real principal balances.
- Budget + subscription detection feed from synced transactions using the categorizer, dedupe, and 50/30/20 machinery unchanged.
- Bank credentials never touch the app; connection repair is outsourced to the Bridge's UI.

**Negative**

- A third party (SimpleFIN Bridge / MX) now sees household financial data — a deliberate, disclosed retreat from ADR-016's zero-third-party stance, traded for freshness.
- Daily granularity only; no intraday balances (acceptable: the domain model is daily aggregates).
- No APR/next-payment detail for either loan; `apr` stays manual.
- Robinhood share counts stay manual (balance syncs; positions don't).
- New moving parts: a cron trigger, a sealed credential, and a sync that must stay idempotent.

**Risks & Mitigations**

- _Cron on TanStack Start_ — the Worker entry is `@tanstack/react-start/server-entry`, which exports only `fetch`. Adding `triggers.crons` needs a thin custom entry that re-exports the Start fetch handler plus a `scheduled()` handler. Small, but it's the one piece of platform plumbing; validate first in Phase 1.
- _ADP 401k connection flakiness_ (worst institution class on any aggregator) → per-account degradation (§6); a stale 401k balance never poisons the rest of the snapshot.
- _Duplicate ingestion if sync re-runs_ → SimpleFIN-id-based `dedupeKey` + the existing CAS ledger update makes re-pulls idempotent by construction.
- _Access URL leakage_ → sealed at rest (§1), server-only, rotatable in minutes via a fresh setup token.
- _Bridge/MX drops an institution_ → CSV import path is retained as the universal fallback.

## Amendment (2026-07-05): holdings sync + per-account history backfill

Two post-ship corrections to the original scope:

1. **Brokerage holdings sync.** "Robinhood share counts stay manual" turned out to be wrong: the Bridge's v2 payload includes a `holdings[]` array (symbol, shares, market_value) for brokerage and crypto accounts. Each sync now maps holdings into `DailyFinanceSnapshot.positions[]` — synced symbols replace manual entries, manual-only positions (e.g. ADP 401k) pass through, and symbols that disappear from holdings (sold) are dropped via a `lastSyncedSymbols` record in `simplefin.json`. §5's rule is unchanged: `netWorth` still sums account balances only; positions remain display-only, so no double-counting.
2. **Per-account history backfill.** The single global cutover date starves recurring-charge detection for accounts linked without CSV history (a new account contributes days, not months, of transactions). `simplefin.json` gains `accountCutovers` (account id → ISO date), and a per-account **"Import 90-day history"** action in the Connections card fetches the Bridge's maximum window (90 days) and ingests that one account's transactions from an earlier cutover. Deliberately explicit, not automatic: backfill is only safe for accounts whose statements were never CSV-imported (SimpleFIN ids can't dedupe against CSV hash keys), and the UI says so.

Also fixed here: the sync previously seeded today's snapshot from `loadDailyFinanceImpl(today)`, which returns an empty snapshot on a new day — wiping manually entered positions. It now reads through the same carry-forward loader as the finance hub (`loadLatestDailyFinanceImpl`).

## Alternatives Considered

1. **Plaid (pay-as-you-go)** — richer (Rocket mortgage detail, Robinhood positions, real-time), but higher cost (~$23+/yr), Production-approval + OAuth-registration friction, per-call Balance billing footgun, and 5–10× the integration/upkeep code — for capabilities outside the app's daily-granularity core loop. Revisit only if mortgage-detail or share-count sync becomes a real want; Plaid can slot in **beside** SimpleFIN behind the same interfaces for a single Item (~$0.20/mo).
2. **Teller** — free tier (100 connections), real-time API; but Link-style connect flow + mTLS client certs, spottier loan-servicer coverage, and more relink code to own. More integration than the value gap justifies here.
3. **Direct integrations (OFX Direct Connect / scraping / bank APIs)** — re-confirmed unavailable or miserable for these institutions (ADR-016's analysis stands; OAuth-first banks killed Direct Connect; scraping is a maintenance treadmill that can't run on Workers).
4. **Balances-only sync (no transactions)** — smaller v1, but keeps the monthly CSV chore that motivated this ADR; the cutover-date scheme (§3) removes the main risk of going full-transactions, so the smaller scope buys little.
5. **Status quo (manual + CSV)** — proven, private, and stale. The freshness gap is the problem statement.

## Open Questions (grilling round — defaults assumed, veto freely)

Asked 2026-07-03; no response received, so the ADR assumes the recommended option for each. Overturning any of these is a small edit, not a redesign:

1. **Token storage**: R2 sealed ref object (assumed) vs Workers secret vs D1.
2. **Sync trigger**: cron + manual button (assumed) vs on-load vs manual-only.
3. **Transaction scope**: full transactions from cutover (assumed) vs balances-only vs fuzzy hash reconciliation of history.
4. **Account mapping**: auto assets + explicit loan links (assumed) vs all-explicit vs fully automatic.

## Next Steps (phasing)

Written for hand-off. Read `docs/ai/architecture.md` and ADR-015/017 first. Two codebase constraints shape everything below:

- **Scope binding**: `getDomainStore()` throws unless a user scope is bound via `AsyncLocalStorage` (`src/server/request-context.ts`, seeded by `src/server/auth-middleware.ts`). Server functions get this for free; a cron `scheduled()` handler does **not** — it must wrap its work in `runWithUserScope("brian", ...)` (any known scope works: all SimpleFIN state and finance data is read/written with `{ shared: true }`, which resolves to the `household` prefix regardless of the bound user).
- **Secrets/env**: follow the shared `src/server/env.ts` seam for reading `SIMPLEFIN_SEAL_KEY` — Cloudflare env first, then test/process overrides. Local `.dev.vars` values are provided by `vp dev` / Wrangler rather than parsed by app code. Deploys go through Workers Builds on push to master; `npm run build` gates on check + tests.

### Phase 0 — cron plumbing spike (gates everything)

**Goal**: prove a Workers cron trigger can run alongside TanStack Start. `wrangler.jsonc` sets `main: "@tanstack/react-start/server-entry"`, which exports only a `fetch` handler.

- Create `src/worker-entry.ts` that re-exports the Start server entry's `fetch` and adds a `scheduled(controller, env, ctx)` handler (initially just a log line). Point `main` at it and add `"triggers": { "crons": ["0 10 * * *"] }` (10:00 UTC = 6am `HOUSEHOLD_TIMEZONE` in summer; note the DST drift and don't chase it — anywhere in the early morning is fine).
- Risk to investigate: whether the Start entry can be cleanly wrapped (import shape, Vite/Workers Builds bundling). If it can't, fallback options in order: (a) a separate tiny scheduled-only Worker in this repo sharing the R2/D1 bindings, calling the same sync module; (b) drop cron and rely on the on-load + manual paths (revisit §2).
- **Done when**: deployed Worker still serves the app, and the cron log line appears in observability (`wrangler tail` or dashboard) after a scheduled fire — or `npx wrangler triggers deploy` + `wrangler dev --test-scheduled` locally with `curl "http://localhost:8787/__scheduled?cron=0+10+*+*+*"`.

### Phase 1 — adapter, sealing, claim flow

**Goal**: paste a setup token in the UI; the server claims and stores the sealed Access URL. Verifiable end-to-end with SimpleFIN's public demo token (see the developer guide at `beta-bridge.simplefin.org/info/developers` — demo access URL `https://demo:demo@beta-bridge.simplefin.org/simplefin` also works to skip claiming during dev).

- `src/server/adapters/simplefin.ts` — the only file that talks HTTP to SimpleFIN, styled after `adapters/quotes.ts` (timeouts, never throws, partial results):
  - `claimSetupToken(token: string): Promise<string>` — the setup token is base64 of a claim URL; `POST` to it (empty body) returns the Access URL.
  - `fetchAccounts(accessUrl: string, opts?: { startDate?: number }): Promise<SimplefinPayload | null>` — `GET {accessUrl}/accounts` with basic-auth parsed from the URL; `start-date` (unix seconds) query controls transaction history depth; `balances-only=1` supported for cheap pulls. Payload shape: `{ errors: string[], accounts: [{ id, org: { name }, name, currency, balance: string, "balance-date": number, transactions: [{ id, posted, amount: string, description, pending? }] }] }`. Amounts are decimal **strings**; parse carefully, never float-multiply money.
  - `sealSecret(plaintext, key)` / `openSecret(ciphertext, key)` — AES-GCM via WebCrypto (`crypto.subtle`), random 12-byte IV prepended, base64 output. Key = `SIMPLEFIN_SEAL_KEY` (32-byte base64; generate with `openssl rand -base64 32`, set via `wrangler secret put` + `.dev.vars`).
- `src/server/finance-sync.ts` — plain logic (ADR-015: no `createServerFn` here). Owns the ref object **`simplefin.json`** (via `store.ref` with `{ shared: true }`, so it lands at `assistant/household/simplefin.json`): `{ sealedAccessUrl, cutoverDate?: ISODate, aliases: Record<sfinAccountId, string>, loanLinks: Record<sfinAccountId, subscriptionId>, lastSync?: { at: number, ok: boolean, accounts: Record<sfinAccountId, { ok: boolean, balanceDate: number, error?: string }> } }`. Always read/write it with `store.ref.update` (etag CAS) — the cron and a manual sync can race.
- `src/server/finance.ts` — new server fns (thin wrappers, `requireAuthSession()` first, like every existing fn there): `connectSimplefin({ setupToken })`, `disconnectSimplefin()`, `getSimplefinStatus()` (returns connection state + `lastSync` + account list with aliases — **never** the access URL, sealed or not).
- UI: a "Connections" card on the finance route (`src/routes/finance.tsx`) — paste-token input, connected-accounts list, disconnect. Keep it inside the existing tab structure.
- **Tests** (vitest, colocated like `finance-parse.test.ts`): seal/open round-trip; payload parsing including string amounts and error arrays; claim-URL decode. HTTP itself stays behind the adapter seam and is not unit-tested.
- **Done when**: demo token connects via the UI, `getSimplefinStatus` lists demo accounts, and `assistant/household/simplefin.json` contains no plaintext URL.

### Phase 2 — balance sync into snapshots

**Goal**: one sync writes today's `DailyFinanceSnapshot` with real balances.

- In `finance-sync.ts`: `runSync({ manual }: { manual: boolean })` —
  1. Load + open the access URL; bail gracefully (recorded in `lastSync`) if unset/unsealable.
  2. `fetchAccounts` (Phase 2: `balances-only=1`).
  3. Map accounts through `aliases` (default alias = `"{org.name} {name}"`); liabilities (loan-linked or negative-balance accounts) stored as **negative** `AccountBalance.amount`.
  4. Merge with the current snapshot via `loadDailyFinanceImpl(todayISO())` (`src/server/domain-impl.ts:310`): synced accounts replace same-name entries, manually tracked accounts and `positions[]` pass through untouched.
  5. Compute `netWorth` **explicitly** = sum of merged account amounts (do NOT let the derive-from-accounts+positions path re-add position values — that double-counts Robinhood) and persist via `saveDailyFinanceImpl` (`domain-impl.ts:325`). Check its signature; if it re-derives netWorth, pass the explicit value or extend it minimally.
  6. Record per-account results + `lastSync` in `simplefin.json`.
- Server fn `syncSimplefinNow()` — rejects if `lastSync.at` is < 1 h old (manual rate limit). Wire a "Sync now" button + per-account "as of `balance-date`" staleness into the Connections card; stale (>48 h) accounts get a visual flag.
- Day-key discipline: compute "today" with the `HOUSEHOLD_TIMEZONE` helpers in `src/lib/domain.ts` (`todayISO`), never raw `new Date().toISOString()` — Workers run UTC.
- **Tests**: merge semantics (synced replaces same-alias, manual accounts survive, positions untouched); explicit netWorth math with negative liabilities; rate-limit check. Use a fake payload; no network.
- **Done when**: pressing "Sync now" (demo token) produces a snapshot whose accounts/netWorth reflect the demo data, and the finance Overview tab shows them.

### Phase 3 — loan links

**Goal**: Truist + Rocket balances auto-update their loan `Subscription`s.

- Extend the Connections card: for each synced account not already linked, offer "link to loan…" listing `kind: "loan"` subscriptions (from `loadSubscriptionsImpl`, `domain-impl.ts:429`). Store as `loanLinks` in `simplefin.json`. Suggest-only for SimpleFIN accounts that look like loans (negative balance / org name match); never auto-create a `Subscription`.
- In `runSync` step 3½: for each `loanLinks` entry, update that subscription's `balance = Math.abs(sfin balance)` via `saveSubscriptionsImpl` semantics (respect its CAS/update path; `apr`, `amount`, and all other fields untouched).
- **Tests**: linked loan balance updates; unlinked loans untouched; a dead link (subscription deleted) is dropped from `loanLinks` rather than erroring.
- **Done when**: a linked demo loan account moves a subscription's balance, and the payoff estimate on the Subscriptions tab changes accordingly.

### Phase 4 — transaction ingestion (cutover)

**Goal**: synced transactions feed the ledger; routine CSV downloads end.

- On the first sync after this phase ships, set `cutoverDate = todayISO()` in `simplefin.json` (CAS; never overwrite an existing value).
- `runSync` drops `balances-only`, passes `start-date` = a few days before `max(cutoverDate, last successful sync)` (overlap is safe — dedupe absorbs it), and ingests via `updateTransactionsImpl` (`domain-impl.ts:372`, same CAS pattern as `importTransactions` in `finance.ts:79`):
  - Skip `pending: true` rows and rows with `posted` before `cutoverDate`.
  - `dedupeKey = "sfin:" + txn.id`; also skip if the key already exists (idempotent re-pulls by construction).
  - Map: `timestamp = posted * 1000`, `amount` = parsed string amount (sign preserved: negative = spend), `type` = `deposit`/`withdrawal` by sign, `account` = the account's alias, `category` = description slice, `categoryGroup` = existing `categorize(description, amount, rules)` from `finance-parse.ts`, `source: "sync"`.
  - Add `"sync"` to the `Transaction["source"]` union in `src/lib/domain.ts` (additive; check nothing narrows on the old union — grep `source ===`).
- CSV import stays untouched as the backfill/fallback path.
- **Tests**: cutover filtering, pending skip, sign/type mapping, sfin-id dedupe across two overlapping pulls, categorizer application. Extend `finance-parse.test.ts` style with fixture payloads.
- **Done when**: two consecutive syncs over overlapping windows add each demo transaction exactly once, categorized, visible in the Budget tab.

### Phase 5 — scheduled sync

**Goal**: unattended daily history.

- Fill in Phase 0's `scheduled()` handler: `runWithUserScope("brian", () => runSync({ manual: false }))` wrapped in `ctx.waitUntil`; catch-all so a sync failure never throws out of the handler. Reuse the manual path's `lastSync` recording so the Connections card shows cron results too.
- Skip the run if a sync succeeded within the last ~20 h? No — cron and manual should coexist; the ≤24/day budget has huge headroom. Just run.
- **Done when**: after ~a week deployed, `daily-finance/{date}.json` exists for every day with no manual action (spot-check R2 or the net-worth trend chart), and cron failures (if any) are visible in `lastSync` + observability logs.

### Post-ship

Swap the demo token for the real household setup token (connect all six institutions on the Bridge first), watch the first real `lastSync` for per-institution errors (expect ADP to be the flaky one), and update ADR-016's "future option" note + `docs/ai/architecture.md` (new adapter + sync module) + glossary "Last updated".
