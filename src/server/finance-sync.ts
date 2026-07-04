/**
 * SimpleFIN sync engine (ADR-019).
 *
 * Plain server logic only: server functions and cron handlers call in here.
 * All state is household-scoped, but callers still need a bound user scope per
 * ADR-017 before `getDomainStore({ shared: true })` can be used.
 */

import type { AccountBalance, ISODate, Subscription, Transaction } from "@/lib/domain";
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
import {
  loadCategoryRulesImpl,
  loadDailyFinanceImpl,
  loadSubscriptionsImpl,
  saveDailyFinanceImpl,
  saveSubscriptionsImpl,
  updateTransactionsImpl,
} from "@/server/domain-impl";
import { getDomainStore } from "@/server/store";

const SIMPLEFIN_REF = "simplefin.json";
const MANUAL_SYNC_INTERVAL_MS = 60 * 60 * 1000;

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
  aliases: Record<string, string>;
  loanLinks: Record<string, string>;
  lastSync?: SimplefinLastSync;
  lastAccounts?: SimplefinSeenAccount[];
  updatedAt?: number;
}

export interface SimplefinPublicStatus {
  connected: boolean;
  cutoverDate?: ISODate;
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
    return { ...state, aliases, loanLinks };
  });
  return getSimplefinStatusImpl();
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
): Promise<number> {
  const cutoverDate = state.cutoverDate;
  if (!cutoverDate) return 0;
  const rules = (await loadCategoryRulesImpl()).rules;
  const now = Date.now();
  let added = 0;

  await updateTransactionsImpl((transactions) => {
    added = 0;
    const seen = new Set(
      transactions
        .filter((t) => !t.deletedAt)
        .map((t) => t.dedupeKey)
        .filter(Boolean) as string[],
    );
    const next: Transaction[] = [...transactions];
    for (const account of payload.accounts) {
      const accountName = displayNameFor(account, state);
      for (const sfinTxn of account.transactions ?? []) {
        if (sfinTxn.pending || !sfinTxn.posted) continue;
        if (dayFromUnixSeconds(sfinTxn.posted) < cutoverDate) continue;
        const dedupeKey = `sfin:${account.id}:${sfinTxn.id}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const amount = parseSimplefinMoney(sfinTxn.amount);
        if (!amount) continue;
        const description = sfinTxn.description || "SimpleFIN transaction";
        next.push({
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
        });
        added++;
      }
    }
    return next;
  });
  return added;
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

  const sealKey = await getSimplefinSealKey();
  if (!state.sealedAccessUrl || !sealKey) {
    const message = !state.sealedAccessUrl
      ? "SimpleFIN is not connected."
      : "SIMPLEFIN_SEAL_KEY is not configured.";
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

  let accessUrl: string;
  try {
    accessUrl = await openSecret(state.sealedAccessUrl, sealKey);
  } catch {
    const message = "Stored SimpleFIN credential could not be opened.";
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

  const effectiveCutover = state.cutoverDate ?? todayISO();
  const fetchResult = await fetchAccounts(accessUrl, {
    startDate: syncStartDate({ ...state, cutoverDate: effectiveCutover }),
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
  const transactionCount = await ingestTransactions(syncState, fetchResult.payload);

  const today = todayISO();
  const currentSnapshot = await loadDailyFinanceImpl(today);
  const syncedBalances = fetchResult.payload.accounts.map((a) => accountBalanceFor(a, syncState));
  const syncedNames = new Set(syncedBalances.map((a) => a.account.toLowerCase()));
  const manualBalances = (currentSnapshot.accounts || []).filter(
    (a) => !syncedNames.has(a.account.toLowerCase()),
  );
  const accounts = [...syncedBalances, ...manualBalances];
  const netWorth = accounts.reduce((sum, account) => sum + account.amount, 0);
  await saveDailyFinanceImpl({
    date: today,
    finance: {
      date: today,
      accounts,
      positions: currentSnapshot.positions || [],
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

export function loanOptionsForStatus(
  subscriptions: Subscription[],
): Pick<Subscription, "id" | "name" | "balance" | "apr">[] {
  return subscriptions
    .filter((s) => !s.deletedAt && s.kind === "loan")
    .map((s) => ({ id: s.id, name: s.name, balance: s.balance, apr: s.apr }));
}
