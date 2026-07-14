/**
 * SimpleFIN sync engine (ADR-019).
 *
 * Plain server logic only: server functions and cron handlers call in here.
 * All state is household-scoped, but callers still need a bound user scope per
 * ADR-017 before `getDomainStore({ shared: true })` can be used.
 */

import type { AccountBalance, ISODate, Position, Subscription, Transaction } from "@/lib/domain";
import { addDaysISO, newId, todayISO } from "@/lib/domain";
import {
  claimSetupToken,
  fetchAccounts,
  getSimplefinSealKey,
  openSecret,
  sealSecret,
  type SimplefinAccount,
  type SimplefinPayload,
} from "@/server/adapters/simplefin";
import { categorize } from "@/server/finance-parse";
import { enrichNewTransactions } from "@/server/finance-ai-match";
import {
  loadCategoryRulesImpl,
  loadLatestDailyFinanceImpl,
  loadSubscriptionsImpl,
  saveDailyFinanceImpl,
  saveSubscriptionsImpl,
  updateTransactionsImpl,
} from "@/server/domain-impl";
import { getDomainStore } from "@/server/store";

const SIMPLEFIN_REF = "simplefin.json";
const MANUAL_SYNC_INTERVAL_MS = 60 * 60 * 1000;
/** SimpleFIN Bridge caps transaction history at 90 days per request. */
const BACKFILL_DAYS = 90;

export interface SimplefinAccountSyncStatus {
  ok: boolean;
  balanceDate?: number;
  error?: string;
}

export interface SimplefinLastSync {
  at: number;
  ok: boolean;
  manual: boolean;
  message?: string;
  transactionCount?: number;
  accounts: Record<string, SimplefinAccountSyncStatus>;
}

export interface SimplefinSeenAccount {
  id: string;
  name: string;
  displayName: string;
  orgName?: string;
  currency: string;
  balance: number;
  balanceDate?: number;
  loanLinkedSubscriptionId?: string;
}

export interface SimplefinState {
  sealedAccessUrl?: string;
  cutoverDate?: ISODate;
  /** Per-account cutover overrides (set by history backfill); earlier than cutoverDate. */
  accountCutovers?: Record<string, ISODate>;
  aliases: Record<string, string>;
  loanLinks: Record<string, string>;
  /** Symbols written by the last holdings sync, so sold positions get removed. */
  lastSyncedSymbols?: string[];
  lastSync?: SimplefinLastSync;
  lastAccounts?: SimplefinSeenAccount[];
  updatedAt?: number;
}

export interface SimplefinPublicStatus {
  connected: boolean;
  cutoverDate?: ISODate;
  accountCutovers: Record<string, ISODate>;
  aliases: Record<string, string>;
  loanLinks: Record<string, string>;
  lastSync?: SimplefinLastSync;
  accounts: SimplefinSeenAccount[];
  manualSyncAvailableAt?: number;
  missingSealKey: boolean;
}

export interface SimplefinSyncResult {
  ok: boolean;
  message: string;
  status: SimplefinPublicStatus;
  transactionCount: number;
}

/**
 * Synced brokerage balances already include their holdings, while manual-only
 * positions still need to contribute to net worth.
 */
export function netWorthAfterSync(accounts: AccountBalance[], positions: Position[]): number {
  return (
    accounts.reduce((sum, account) => sum + account.amount, 0) +
    positions
      .filter((position) => position.includedInNetWorth !== false)
      .reduce((sum, position) => sum + position.value, 0)
  );
}

function emptyState(): SimplefinState {
  return {
    aliases: {},
    loanLinks: {},
  };
}

function normalizeState(state: SimplefinState | null): SimplefinState {
  return {
    ...emptyState(),
    ...state,
    aliases: state?.aliases ?? {},
    loanLinks: state?.loanLinks ?? {},
    lastAccounts: state?.lastAccounts ?? [],
  };
}

async function updateSimplefinState(
  mutate: (state: SimplefinState) => SimplefinState,
): Promise<SimplefinState> {
  const store = await getDomainStore({ shared: true });
  return store.ref.update<SimplefinState>(SIMPLEFIN_REF, (current) => ({
    ...mutate(normalizeState(current)),
    updatedAt: Date.now(),
  }));
}

export async function loadSimplefinStateImpl(): Promise<SimplefinState> {
  const store = await getDomainStore({ shared: true });
  return normalizeState(await store.ref.get<SimplefinState>(SIMPLEFIN_REF));
}

export async function getSimplefinStatusImpl(): Promise<SimplefinPublicStatus> {
  const [state, sealKey] = await Promise.all([loadSimplefinStateImpl(), getSimplefinSealKey()]);
  const nextManual =
    state.lastSync?.manual && state.lastSync.at + MANUAL_SYNC_INTERVAL_MS > Date.now()
      ? state.lastSync.at + MANUAL_SYNC_INTERVAL_MS
      : undefined;
  return {
    connected: !!state.sealedAccessUrl,
    cutoverDate: state.cutoverDate,
    accountCutovers: state.accountCutovers ?? {},
    aliases: state.aliases,
    loanLinks: state.loanLinks,
    lastSync: state.lastSync,
    accounts: state.lastAccounts ?? [],
    manualSyncAvailableAt: nextManual,
    missingSealKey: !sealKey,
  };
}

export async function connectSimplefinImpl(setupToken: string): Promise<SimplefinPublicStatus> {
  const sealKey = await getSimplefinSealKey();
  if (!sealKey) throw new Error("SIMPLEFIN_SEAL_KEY is not configured.");
  const claimed = await claimSetupToken(setupToken.trim());
  if (!claimed.accessUrl) throw new Error(claimed.error || "Could not claim SimpleFIN token.");
  const sealedAccessUrl = await sealSecret(claimed.accessUrl, sealKey);
  await updateSimplefinState((state) => ({
    ...state,
    sealedAccessUrl,
  }));
  return getSimplefinStatusImpl();
}

export async function disconnectSimplefinImpl(): Promise<SimplefinPublicStatus> {
  await updateSimplefinState((state) => ({
    aliases: state.aliases,
    loanLinks: state.loanLinks,
    lastAccounts: state.lastAccounts,
    lastSync: {
      at: Date.now(),
      ok: true,
      manual: true,
      message: "SimpleFIN disconnected. Revoke the access token on SimpleFIN Bridge if needed.",
      accounts: {},
    },
  }));
  return getSimplefinStatusImpl();
}

export async function saveSimplefinMappingsImpl(data: {
  aliases?: Record<string, string>;
  loanLinks?: Record<string, string | null>;
}): Promise<SimplefinPublicStatus> {
  const state = await loadSimplefinStateImpl();
  const renames = deriveAliasRenames(state, data.aliases ?? {});
  await updateSimplefinState((state) => {
    const aliases = { ...state.aliases };
    for (const [id, alias] of Object.entries(data.aliases ?? {})) {
      const clean = alias.trim();
      if (clean) aliases[id] = clean;
      else delete aliases[id];
    }
    const loanLinks = { ...state.loanLinks };
    for (const [accountId, subscriptionId] of Object.entries(data.loanLinks ?? {})) {
      if (subscriptionId) loanLinks[accountId] = subscriptionId;
      else delete loanLinks[accountId];
    }
    const renamedById = new Map(renames.map((rename) => [rename.accountId, rename.to]));
    const lastAccounts = (state.lastAccounts ?? []).map((account) => {
      const displayName = renamedById.get(account.id);
      return displayName ? { ...account, displayName } : account;
    });
    return { ...state, aliases, loanLinks, lastAccounts };
  });
  await renameTransactionAccounts(renames);
  return getSimplefinStatusImpl();
}

export interface TransactionAccountRename {
  from: string[];
  to: string;
}

interface AccountAliasRename extends TransactionAccountRename {
  accountId: string;
}

export function deriveAliasRenames(
  state: SimplefinState,
  incomingAliases: Record<string, string>,
): AccountAliasRename[] {
  const accounts = new Map((state.lastAccounts ?? []).map((account) => [account.id, account]));
  const renames: AccountAliasRename[] = [];
  for (const [accountId, alias] of Object.entries(incomingAliases)) {
    const account = accounts.get(accountId);
    if (!account) continue;
    const rawName = [account.orgName, account.name].filter(Boolean).join(" ").trim();
    const oldDisplay = state.aliases[accountId]?.trim() || rawName;
    const newDisplay = alias.trim() || rawName;
    if (newDisplay === oldDisplay) continue;
    const from = [...new Set([rawName, oldDisplay, account.displayName].filter(Boolean))];
    renames.push({ accountId, from, to: newDisplay });
  }
  return renames;
}

/**
 * Renames to run on every sync. A row frozen under an account's raw bank label
 * (ingested before the user aliased that account) never sees a *change* between
 * syncs, so a change-detector alone would leave it orphaned under the old name.
 * Sweeping `rawName -> current display name` unconditionally heals those rows;
 * it's a no-op once healed (and when no alias is set, rawName === display name).
 */
export function deriveSyncRenames(
  state: SimplefinState,
  payload: SimplefinPayload,
): TransactionAccountRename[] {
  const previous = new Map((state.lastAccounts ?? []).map((account) => [account.id, account]));
  const renames: TransactionAccountRename[] = [];
  for (const account of payload.accounts) {
    const newDisplay = displayNameFor(account, state);
    const rawName = [account.org?.name || account.conn_name, account.name]
      .filter(Boolean)
      .join(" ")
      .trim();
    const from = [...new Set([previous.get(account.id)?.displayName, rawName].filter(Boolean))];
    if (from.length) renames.push({ from: from as string[], to: newDisplay });
  }
  return renames;
}

function renameMapFor(renames: TransactionAccountRename[]): Map<string, string> {
  const renameMap = new Map<string, string>();
  for (const rename of renames) {
    const toKey = rename.to.trim().toLowerCase();
    for (const from of rename.from) {
      const fromKey = from.trim().toLowerCase();
      if (fromKey && fromKey !== toKey) renameMap.set(fromKey, rename.to);
    }
  }
  return renameMap;
}

export async function renameTransactionAccounts(
  renames: TransactionAccountRename[],
): Promise<number> {
  const renameMap = renameMapFor(renames);
  if (!renameMap.size) return 0;
  let changed = 0;
  // SimpleFIN transaction rows freeze the display label used when they were ingested.
  await updateTransactionsImpl((transactions) => {
    const result = rewriteTransactionAccountLabels(transactions, renames);
    changed = result.changed;
    return result.transactions;
  });
  return changed;
}

export function rewriteTransactionAccountLabels(
  transactions: Transaction[],
  renames: TransactionAccountRename[],
): { transactions: Transaction[]; changed: number } {
  const renameMap = renameMapFor(renames);
  let changed = 0;
  const rewritten = transactions.map((transaction) => {
    const account = transaction.account
      ? renameMap.get(transaction.account.trim().toLowerCase())
      : undefined;
    if (!account || account === transaction.account) return transaction;
    changed++;
    return { ...transaction, account };
  });
  return { transactions: rewritten, changed };
}

function displayNameFor(account: SimplefinAccount, state: SimplefinState): string {
  const alias = state.aliases[account.id]?.trim();
  if (alias) return alias;
  const orgName = account.org?.name || account.conn_name;
  return [orgName, account.name].filter(Boolean).join(" ").trim() || account.id;
}

export function parseSimplefinMoney(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * Flatten brokerage holdings across all accounts into snapshot positions,
 * aggregating duplicate symbols. The sync marks these positions
 * `includedInNetWorth: false` because their account balance already includes
 * them; manual-only positions continue to contribute to net worth.
 */
export function positionsFromHoldings(payload: SimplefinPayload): Position[] {
  const bySymbol = new Map<string, Position>();
  for (const account of payload.accounts) {
    for (const holding of account.holdings ?? []) {
      const symbol = holding.symbol?.trim().toUpperCase();
      const quantity = Number(holding.shares);
      const value = parseSimplefinMoney(holding.market_value);
      if (!symbol || !Number.isFinite(quantity) || quantity <= 0 || value <= 0) continue;
      const prev = bySymbol.get(symbol);
      const totalQuantity = (prev?.quantity ?? 0) + quantity;
      const totalValue = Math.round(((prev?.value ?? 0) + value) * 100) / 100;
      bySymbol.set(symbol, {
        symbol,
        quantity: totalQuantity,
        value: totalValue,
        price: totalQuantity ? Math.round((totalValue / totalQuantity) * 100) / 100 : 0,
      });
    }
  }
  return [...bySymbol.values()].sort((a, b) => b.value - a.value);
}

/**
 * Merge synced balances with the current snapshot's accounts. Manual accounts
 * pass through, but rows written by a previous sync under a *different* alias
 * (the account was renamed) are dropped — otherwise a rename double-counts the
 * account. `staleNames` must only contain previous display names of accounts
 * present in the current payload, so a partially-failed sync still keeps
 * last-known balances for accounts the Bridge omitted (ADR-019 §6).
 */
export function mergeAccountBalances(
  synced: AccountBalance[],
  existing: AccountBalance[],
  staleNames: string[],
): AccountBalance[] {
  const drop = new Set(
    [...synced.map((a) => a.account), ...staleNames].map((n) => n.toLowerCase()),
  );
  return [...synced, ...existing.filter((a) => !drop.has(a.account.toLowerCase()))];
}

/**
 * Synced holdings replace manual entries per symbol; manual positions for
 * anything SimpleFIN doesn't cover (e.g. ADP 401k) pass through. Symbols the
 * previous sync wrote but that no longer appear were sold — drop them.
 */
export function mergePositions(
  synced: Position[],
  existing: Position[],
  previousSyncedSymbols: string[],
): Position[] {
  const owned = new Set([...synced.map((p) => p.symbol), ...previousSyncedSymbols]);
  const manual = existing.filter((p) => !owned.has((p.symbol || "").trim().toUpperCase()));
  return [...synced, ...manual];
}

function accountBalanceFor(account: SimplefinAccount, state: SimplefinState): AccountBalance {
  const raw = parseSimplefinMoney(account.balance);
  const linkedLoan = !!state.loanLinks[account.id];
  const amount = linkedLoan ? -Math.abs(raw) : raw;
  return {
    account: displayNameFor(account, state),
    amount,
    currency: account.currency || "USD",
  };
}

function seenAccountFor(account: SimplefinAccount, state: SimplefinState): SimplefinSeenAccount {
  return {
    id: account.id,
    name: account.name,
    displayName: displayNameFor(account, state),
    orgName: account.org?.name || account.conn_name,
    currency: account.currency || "USD",
    balance: parseSimplefinMoney(account.balance),
    balanceDate: account["balance-date"],
    loanLinkedSubscriptionId: state.loanLinks[account.id],
  };
}

function accountStatuses(
  payload: SimplefinPayload | null,
  fallbackError?: string,
): Record<string, SimplefinAccountSyncStatus> {
  const statuses: Record<string, SimplefinAccountSyncStatus> = {};
  for (const account of payload?.accounts ?? []) {
    statuses[account.id] = { ok: true, balanceDate: account["balance-date"] };
  }
  for (const err of payload?.errlist ?? []) {
    const id = err.account_id;
    if (!id) continue;
    statuses[id] = {
      ok: false,
      error: err.msg || err.code || "SimpleFIN account error.",
    };
  }
  if (!payload && fallbackError) statuses._connection = { ok: false, error: fallbackError };
  return statuses;
}

function dayFromUnixSeconds(seconds: number): ISODate {
  return new Date(seconds * 1000).toISOString().slice(0, 10) as ISODate;
}

function syncStartDate(state: SimplefinState): number | undefined {
  const cutover = state.cutoverDate;
  const lastOk = state.lastSync?.ok ? state.lastSync.at : undefined;
  const lastOkDay = lastOk ? (new Date(lastOk).toISOString().slice(0, 10) as ISODate) : undefined;
  const startDay = cutover && lastOkDay ? (cutover > lastOkDay ? cutover : lastOkDay) : cutover;
  if (!startDay) return undefined;
  return Math.floor(new Date(addDaysISO(startDay, -3) + "T00:00:00Z").getTime() / 1000);
}

async function updateLinkedLoans(
  state: SimplefinState,
  payload: SimplefinPayload,
): Promise<Record<string, string>> {
  const deadLinks: Record<string, string> = {};
  if (!Object.keys(state.loanLinks).length) return deadLinks;

  const accountById = new Map(payload.accounts.map((a) => [a.id, a]));
  const store = await loadSubscriptionsImpl();
  const now = Date.now();
  let changed = false;
  const next = store.subscriptions.map((sub) => {
    const accountId = Object.entries(state.loanLinks).find(([, subId]) => subId === sub.id)?.[0];
    if (!accountId) return sub;
    const account = accountById.get(accountId);
    if (!account) return sub;
    changed = true;
    return {
      ...sub,
      balance: Math.abs(parseSimplefinMoney(account.balance)),
      updatedAt: now,
    };
  });

  for (const [accountId, subId] of Object.entries(state.loanLinks)) {
    if (!store.subscriptions.some((s) => s.id === subId)) deadLinks[accountId] = subId;
  }

  if (changed || Object.keys(deadLinks).length) {
    await saveSubscriptionsImpl({ subscriptions: next });
  }
  return deadLinks;
}

async function ingestTransactions(
  state: SimplefinState,
  payload: SimplefinPayload,
): Promise<{ added: number; newTxns: Transaction[] }> {
  if (!state.cutoverDate && !Object.keys(state.accountCutovers ?? {}).length) {
    return { added: 0, newTxns: [] };
  }
  const rules = (await loadCategoryRulesImpl()).rules;
  const now = Date.now();
  let added = 0;
  let newTxns: Transaction[] = [];

  await updateTransactionsImpl((transactions) => {
    added = 0;
    newTxns = [];
    const seen = new Set(
      transactions
        .filter((t) => !t.deletedAt)
        .map((t) => t.dedupeKey)
        .filter(Boolean) as string[],
    );
    const next: Transaction[] = [...transactions];
    for (const account of payload.accounts) {
      const accountName = displayNameFor(account, state);
      const cutoverDate = state.accountCutovers?.[account.id] ?? state.cutoverDate;
      if (!cutoverDate) continue;
      for (const sfinTxn of account.transactions ?? []) {
        if (sfinTxn.pending || !sfinTxn.posted) continue;
        if (dayFromUnixSeconds(sfinTxn.posted) < cutoverDate) continue;
        const dedupeKey = `sfin:${account.id}:${sfinTxn.id}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const amount = parseSimplefinMoney(sfinTxn.amount);
        if (!amount) continue;
        const description = sfinTxn.description || "SimpleFIN transaction";
        const txn: Transaction = {
          id: newId("txn"),
          createdAt: now,
          timestamp: sfinTxn.posted * 1000,
          type: amount > 0 ? "deposit" : "withdrawal",
          amount,
          currency: account.currency || "USD",
          account: accountName,
          category: description.slice(0, 60),
          categoryGroup: categorize(description, amount, rules),
          dedupeKey,
          source: "sync",
        };
        next.push(txn);
        newTxns.push(txn);
        added++;
      }
    }
    return next;
  });
  return { added, newTxns };
}

async function resolveAccessUrl(
  state: SimplefinState,
): Promise<{ accessUrl?: string; error: string }> {
  const sealKey = await getSimplefinSealKey();
  if (!state.sealedAccessUrl) return { error: "SimpleFIN is not connected." };
  if (!sealKey) return { error: "SIMPLEFIN_SEAL_KEY is not configured." };
  try {
    return { accessUrl: await openSecret(state.sealedAccessUrl, sealKey), error: "" };
  } catch {
    return { error: "Stored SimpleFIN credential could not be opened." };
  }
}

/**
 * SimpleFIN's Bridge re-pulls from the member's banks on demand, so the first
 * fetch of the day (the 6am cron) is often cold and slow. A snappy 12s abort is
 * right for the manual "Sync now" button (a user is waiting), but it makes the
 * scheduled sync fail with "The operation was aborted" nearly every morning.
 * For scheduled runs — where nothing is blocking on the response — allow a much
 * longer budget and one retry so a cold Bridge still completes.
 */
async function fetchAccountsResilient(
  accessUrl: string,
  opts: { startDate?: number; manual: boolean },
): Promise<Awaited<ReturnType<typeof fetchAccounts>>> {
  const timeoutMs = opts.manual ? 12_000 : 45_000;
  const attempts = opts.manual ? 1 : 2;
  let last: Awaited<ReturnType<typeof fetchAccounts>> | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await fetchAccounts(accessUrl, { startDate: opts.startDate, timeoutMs });
    if (last.payload) return last;
  }
  return last!;
}

export async function runSimplefinSyncImpl(args: {
  manual: boolean;
  force?: boolean;
}): Promise<SimplefinSyncResult> {
  const startedAt = Date.now();
  const state = await loadSimplefinStateImpl();
  if (args.manual && !args.force && state.lastSync?.manual) {
    const availableAt = state.lastSync.at + MANUAL_SYNC_INTERVAL_MS;
    if (availableAt > startedAt) {
      return {
        ok: false,
        message: "Manual SimpleFIN sync is limited to once per hour.",
        status: await getSimplefinStatusImpl(),
        transactionCount: 0,
      };
    }
  }

  const resolved = await resolveAccessUrl(state);
  if (!resolved.accessUrl) {
    const message = resolved.error;
    await updateSimplefinState((current) => ({
      ...current,
      lastSync: {
        at: startedAt,
        ok: false,
        manual: args.manual,
        message,
        accounts: {},
      },
    }));
    return {
      ok: false,
      message,
      status: await getSimplefinStatusImpl(),
      transactionCount: 0,
    };
  }
  const accessUrl = resolved.accessUrl;

  const effectiveCutover = state.cutoverDate ?? todayISO();
  const fetchResult = await fetchAccountsResilient(accessUrl, {
    startDate: syncStartDate({ ...state, cutoverDate: effectiveCutover }),
    manual: args.manual,
  });
  if (!fetchResult.payload) {
    const message = fetchResult.error || "SimpleFIN sync failed.";
    await updateSimplefinState((current) => ({
      ...current,
      cutoverDate: current.cutoverDate ?? effectiveCutover,
      lastSync: {
        at: startedAt,
        ok: false,
        manual: args.manual,
        message,
        accounts: accountStatuses(null, message),
      },
    }));
    return {
      ok: false,
      message,
      status: await getSimplefinStatusImpl(),
      transactionCount: 0,
    };
  }

  const syncState = { ...state, cutoverDate: effectiveCutover };
  const deadLinks = await updateLinkedLoans(syncState, fetchResult.payload);
  for (const accountId of Object.keys(deadLinks)) delete syncState.loanLinks[accountId];
  const { added: transactionCount, newTxns } = await ingestTransactions(
    syncState,
    fetchResult.payload,
  );
  await renameTransactionAccounts(deriveSyncRenames(syncState, fetchResult.payload));
  await enrichNewTransactions(newTxns, { manual: args.manual });

  const today = todayISO();
  const { snapshot: currentSnapshot } = await loadLatestDailyFinanceImpl(today);
  const syncedBalances = fetchResult.payload.accounts.map((a) => accountBalanceFor(a, syncState));
  const syncedIds = new Set(fetchResult.payload.accounts.map((a) => a.id));
  const staleNames = (state.lastAccounts ?? [])
    .filter((prev) => syncedIds.has(prev.id))
    .map((prev) => prev.displayName);
  const accounts = mergeAccountBalances(syncedBalances, currentSnapshot.accounts || [], staleNames);
  const syncedPositions = positionsFromHoldings(fetchResult.payload);
  const positions = mergePositions(
    syncedPositions.map((position) => ({ ...position, includedInNetWorth: false })),
    currentSnapshot.positions || [],
    state.lastSyncedSymbols ?? [],
  );
  const netWorth = netWorthAfterSync(accounts, positions);
  await saveDailyFinanceImpl({
    date: today,
    finance: {
      date: today,
      accounts,
      positions,
      netWorth,
    },
  });

  const statusAccounts = accountStatuses(fetchResult.payload);
  const bridgeErrors = [
    ...(fetchResult.payload.errlist ?? []).map((e) => e.msg || e.code).filter(Boolean),
    ...(fetchResult.payload.errors ?? []),
  ];
  const message = bridgeErrors.length
    ? `SimpleFIN sync completed with ${bridgeErrors.length} Bridge warning(s).`
    : `SimpleFIN sync completed: ${fetchResult.payload.accounts.length} accounts, ${transactionCount} new transactions.`;
  await updateSimplefinState((current) => ({
    ...current,
    cutoverDate: current.cutoverDate ?? effectiveCutover,
    loanLinks: Object.fromEntries(
      Object.entries(current.loanLinks ?? {}).filter(([accountId]) => !deadLinks[accountId]),
    ),
    lastAccounts: fetchResult.payload!.accounts.map((a) => seenAccountFor(a, syncState)),
    lastSyncedSymbols: syncedPositions.map((p) => p.symbol),
    lastSync: {
      at: startedAt,
      ok: bridgeErrors.length === 0,
      manual: args.manual,
      message,
      transactionCount,
      accounts: statusAccounts,
    },
  }));

  return {
    ok: bridgeErrors.length === 0,
    message,
    status: await getSimplefinStatusImpl(),
    transactionCount,
  };
}

export interface SimplefinBackfillResult {
  ok: boolean;
  message: string;
  added: number;
}

/**
 * One-time deep pull for a single account: ingest up to 90 days of history
 * (the Bridge's cap) so recurring-charge detection has enough repeats to work
 * with. Explicitly per-account because the global cutover exists to protect
 * accounts with CSV-imported history from double-counting — only backfill
 * accounts whose statements were never imported.
 */
export async function backfillSimplefinHistoryImpl(
  accountId: string,
): Promise<SimplefinBackfillResult> {
  const state = await loadSimplefinStateImpl();
  const resolved = await resolveAccessUrl(state);
  if (!resolved.accessUrl) return { ok: false, message: resolved.error, added: 0 };

  const startSeconds = Math.floor(Date.now() / 1000) - BACKFILL_DAYS * 24 * 60 * 60;
  const backfillDay = dayFromUnixSeconds(startSeconds);
  const fetchResult = await fetchAccounts(resolved.accessUrl, { startDate: startSeconds });
  if (!fetchResult.payload) {
    return { ok: false, message: fetchResult.error || "SimpleFIN history fetch failed.", added: 0 };
  }
  const account = fetchResult.payload.accounts.find((a) => a.id === accountId);
  if (!account) {
    return { ok: false, message: "Account not found in the SimpleFIN payload.", added: 0 };
  }

  const backfillState: SimplefinState = {
    ...state,
    accountCutovers: { ...state.accountCutovers, [accountId]: backfillDay },
  };
  const { added, newTxns } = await ingestTransactions(backfillState, {
    ...fetchResult.payload,
    accounts: [account],
  });
  await enrichNewTransactions(newTxns, { manual: true });

  // Persist the earlier cutover so daily syncs keep accepting this window and
  // re-running the backfill stays idempotent (sfin-id dedupe absorbs re-pulls).
  await updateSimplefinState((current) => {
    const existing = current.accountCutovers?.[accountId];
    if (existing && existing <= backfillDay) return current;
    return {
      ...current,
      accountCutovers: { ...current.accountCutovers, [accountId]: backfillDay },
    };
  });

  return {
    ok: true,
    message: `Imported ${added} transaction(s) since ${backfillDay} for ${displayNameFor(account, state)}.`,
    added,
  };
}

/** True for rows a history backfill added: synced, this account, before the global cutover. */
export function isBackfilledTransaction(
  t: Transaction,
  accountId: string,
  cutoverDate: ISODate | undefined,
): boolean {
  if (t.source !== "sync" || !t.dedupeKey?.startsWith(`sfin:${accountId}:`)) return false;
  if (!cutoverDate) return true;
  return (new Date(t.timestamp).toISOString().slice(0, 10) as ISODate) < cutoverDate;
}

/**
 * Reverse a history backfill: soft-delete the pre-cutover synced rows for the
 * account and drop its cutover override. Escape hatch for backfilling an
 * account whose statements were already CSV-imported (double-counted rows).
 */
export async function undoSimplefinBackfillImpl(
  accountId: string,
): Promise<SimplefinBackfillResult> {
  const state = await loadSimplefinStateImpl();
  const now = Date.now();
  let removed = 0;
  await updateTransactionsImpl((transactions) => {
    removed = 0;
    return transactions.map((t) => {
      if (t.deletedAt || !isBackfilledTransaction(t, accountId, state.cutoverDate)) return t;
      removed++;
      return { ...t, deletedAt: now, updatedAt: now };
    });
  });
  await updateSimplefinState((current) => {
    const accountCutovers = { ...current.accountCutovers };
    delete accountCutovers[accountId];
    return { ...current, accountCutovers };
  });
  return {
    ok: true,
    message: `Removed ${removed} backfilled transaction(s).`,
    added: -removed,
  };
}

export function loanOptionsForStatus(
  subscriptions: Subscription[],
): Pick<Subscription, "id" | "name" | "balance" | "apr">[] {
  return subscriptions
    .filter((s) => !s.deletedAt && s.kind === "loan")
    .map((s) => ({ id: s.id, name: s.name, balance: s.balance, apr: s.apr }));
}
