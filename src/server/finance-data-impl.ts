import type {
  Budget,
  CategoryGroup,
  DailyFinanceSnapshot,
  ISODate,
  Subscription,
  Transaction,
} from "@/lib/domain";
import { newId } from "@/lib/domain";
import { getDomainStore } from "@/server/store";

export type DailyFinancePayload = DailyFinanceSnapshot & { updatedAt: number };
export type TransactionsStore = {
  transactions: Transaction[];
  updatedAt: number;
};

export async function loadDailyFinanceImpl(date: ISODate): Promise<DailyFinancePayload> {
  const store = await getDomainStore({ shared: true });
  const stored = await store.daily.get<DailyFinancePayload>("daily-finance", date);
  if (stored) return stored;
  return {
    id: `finance-${date}`,
    date,
    netWorth: 0,
    accounts: [],
    positions: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Latest snapshot on or before `date` (carry-forward). Sync and the hub both
 * read through this so a new day starts from yesterday's accounts/positions
 * instead of an empty snapshot.
 */
export async function loadLatestDailyFinanceImpl(
  date: ISODate,
): Promise<{ snapshot: DailyFinancePayload; sourceDate: ISODate }> {
  const store = await getDomainStore({ shared: true });
  const exact = await store.daily.get<DailyFinancePayload>("daily-finance", date);
  if (exact) return { snapshot: exact, sourceDate: date };

  const { getUserPrefix, listKeys } = await import("@/server/adapters/r2");
  const { HOUSEHOLD_ID } = await import("@/lib/scope");
  const prefix = `${getUserPrefix(HOUSEHOLD_ID)}/daily-finance/`;
  const dates = (await listKeys(prefix))
    .map((key) => key.match(/\/daily-finance\/(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
    .filter((d): d is ISODate => !!d && d <= date)
    .sort((a, b) => b.localeCompare(a));

  for (const sourceDate of dates) {
    const snapshot = await store.daily.get<DailyFinancePayload>("daily-finance", sourceDate);
    if (snapshot) {
      return {
        snapshot: { ...snapshot, id: `finance-${date}`, date },
        sourceDate,
      };
    }
  }

  return { snapshot: await loadDailyFinanceImpl(date), sourceDate: date };
}

export async function saveDailyFinanceImpl(data: {
  date: ISODate;
  finance: Omit<
    DailyFinanceSnapshot,
    "id" | "createdAt" | "updatedAt" | "deletedAt" | "netWorth"
  > & {
    netWorth?: number;
  };
}): Promise<DailyFinancePayload> {
  const now = Date.now();
  for (const account of data.finance.accounts || []) {
    if ((account.currency || "USD").toUpperCase() !== "USD") {
      throw new Error("Finance totals currently support USD accounts only.");
    }
  }
  const accountsTotal = (data.finance.accounts || []).reduce(
    (s, a: { amount?: number }) => s + (a.amount || 0),
    0,
  );
  const positionsTotal = (data.finance.positions || []).reduce(
    (s, p: { value?: number; includedInNetWorth?: boolean }) =>
      s + (p.includedInNetWorth === false ? 0 : p.value || 0),
    0,
  );
  const full: DailyFinancePayload = {
    id: `finance-${data.date}`,
    ...data.finance,
    date: data.date,
    netWorth: data.finance.netWorth ?? accountsTotal + positionsTotal,
    createdAt: (data.finance as any).createdAt ?? now,
    updatedAt: now,
  };
  const store = await getDomainStore({ shared: true });
  await store.daily.put("daily-finance", data.date, full);
  return full;
}

export async function loadTransactionsImpl(): Promise<TransactionsStore> {
  const store = await getDomainStore({ shared: true });
  return (
    (await store.ref.get<TransactionsStore>("transactions.json")) ?? {
      transactions: [],
      updatedAt: Date.now(),
    }
  );
}

/**
 * Atomically mutate the shared transaction ledger (etag CAS + retry). Both
 * household members write this file, so every ledger mutation must go through
 * here rather than load → save, or concurrent writers drop each other's data.
 * `mutate` may run more than once on conflict — keep it pure over its input.
 */
export async function updateTransactionsImpl(
  mutate: (transactions: Transaction[]) => Transaction[],
): Promise<TransactionsStore> {
  const store = await getDomainStore({ shared: true });
  return store.ref.update<TransactionsStore>("transactions.json", (current) => ({
    transactions: mutate(current?.transactions ?? []),
    updatedAt: Date.now(),
  }));
}

export async function appendTransactionImpl(
  data: Omit<Transaction, "id" | "createdAt">,
): Promise<Transaction> {
  const now = Date.now();
  const transaction: Transaction = {
    id: newId("txn"),
    createdAt: now,
    ...data,
    currency: data.currency ?? "USD",
    timestamp: data.timestamp ?? now,
  };
  await updateTransactionsImpl((transactions) => [...transactions, transaction]);
  return transaction;
}

/* ---------- Budget (50/30/20) ---------- */

export type BudgetPayload = Budget & { updatedAt: number };

export async function loadBudgetImpl(): Promise<BudgetPayload | null> {
  const store = await getDomainStore({ shared: true });
  return store.ref.get<BudgetPayload>("budget.json");
}

export async function saveBudgetImpl(data: {
  budget: Omit<Budget, "id" | "createdAt" | "updatedAt" | "deletedAt">;
}): Promise<BudgetPayload> {
  const now = Date.now();
  const existing = await loadBudgetImpl();
  const payload: BudgetPayload = {
    id: "budget",
    ...data.budget,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const store = await getDomainStore({ shared: true });
  await store.ref.put("budget.json", payload);
  return payload;
}

/* ---------- Subscriptions ---------- */

export type SubscriptionsStore = {
  subscriptions: Subscription[];
  updatedAt: number;
};

export async function loadSubscriptionsImpl(): Promise<SubscriptionsStore> {
  const store = await getDomainStore({ shared: true });
  return (
    (await store.ref.get<SubscriptionsStore>("subscriptions.json")) ?? {
      subscriptions: [],
      updatedAt: Date.now(),
    }
  );
}

export async function saveSubscriptionsImpl(data: {
  subscriptions: Subscription[];
}): Promise<SubscriptionsStore> {
  const payload: SubscriptionsStore = {
    subscriptions: data.subscriptions,
    updatedAt: Date.now(),
  };
  const store = await getDomainStore({ shared: true });
  await store.ref.put("subscriptions.json", payload);
  return payload;
}

/* ---------- Category rules (learned overrides) ---------- */

export type CategoryRulesStore = {
  /** Lowercased merchant/keyword → 50/30/20 group. */
  rules: Record<string, CategoryGroup>;
  updatedAt: number;
};

export async function loadCategoryRulesImpl(): Promise<CategoryRulesStore> {
  const store = await getDomainStore({ shared: true });
  return (
    (await store.ref.get<CategoryRulesStore>("category-rules.json")) ?? {
      rules: {},
      updatedAt: Date.now(),
    }
  );
}

/** Atomically merge learned category rules (etag CAS + retry, shared file). */
export async function updateCategoryRulesImpl(
  mutate: (rules: Record<string, CategoryGroup>) => Record<string, CategoryGroup>,
): Promise<CategoryRulesStore> {
  const store = await getDomainStore({ shared: true });
  return store.ref.update<CategoryRulesStore>("category-rules.json", (current) => ({
    rules: mutate(current?.rules ?? {}),
    updatedAt: Date.now(),
  }));
}

/**
 * Productivity tasks are split across two scopes (ADR-017): personal tasks live
 * in the signed-in user's scope, shared (household) tasks in the shared scope.
 * Load merges both — tagging each task with its `shared` origin — so a single
 * combined view shows "mine + shared". Save routes each task back to the
 * correct scope by its `shared` flag.
 */
