import type { ISODate, Subscription, Transaction } from "@/lib/domain";
import { isCuttableSubscription, subscriptionMonthlyCost } from "@/lib/domain";
import {
  addUnseenRecurringToBuckets,
  analyzeRecurringHealth,
  monthKey,
  rollupMonth,
  type MonthBuckets,
  type RecurringInsight,
} from "@/lib/finance-math";
import {
  loadBudgetImpl,
  loadLatestDailyFinanceImpl,
  loadSubscriptionsImpl,
  loadTransactionsImpl,
  saveSubscriptionsImpl,
  type BudgetPayload,
  type DailyFinancePayload,
} from "@/server/domain-impl";

export interface FinanceHubPayload {
  snapshot: DailyFinancePayload;
  snapshotSourceDate: ISODate;
  budget: BudgetPayload | null;
  subscriptions: Subscription[];
  transactions: Transaction[];
  recurringInsights: RecurringInsight[];
}

/** Load the most recent finance snapshot on or before the requested day. */
export async function loadFinanceSnapshotForHubImpl(
  day: ISODate,
): Promise<{ snapshot: DailyFinancePayload; sourceDate: ISODate }> {
  return loadLatestDailyFinanceImpl(day);
}

/** Assemble the Finance Hub's single read payload. */
export async function loadFinanceHubImpl(day: ISODate): Promise<FinanceHubPayload> {
  const [snapshotInfo, budget, subs, txns] = await Promise.all([
    loadFinanceSnapshotForHubImpl(day),
    loadBudgetImpl(),
    loadSubscriptionsImpl(),
    loadTransactionsImpl(),
  ]);
  const subscriptions = subs.subscriptions.filter((s) => !s.deletedAt);
  const transactions = txns.transactions.filter((t) => !t.deletedAt);
  return {
    snapshot: snapshotInfo.snapshot,
    snapshotSourceDate: snapshotInfo.sourceDate,
    budget,
    subscriptions,
    transactions,
    recurringInsights: analyzeRecurringHealth({ subscriptions, transactions }),
  };
}

export type ApplyRecurringInsightAction = "update-amount" | "cancel";

export async function applyRecurringInsightImpl(data: {
  subscriptionId: string;
  action: ApplyRecurringInsightAction;
  amount?: number;
  lastSeen?: number;
}): Promise<{ ok: true }> {
  const subscriptionId = data.subscriptionId?.trim();
  if (!subscriptionId) throw new Error("subscriptionId is required");

  const [subsStore, txnStore] = await Promise.all([
    loadSubscriptionsImpl(),
    loadTransactionsImpl(),
  ]);
  const subscriptions = subsStore.subscriptions.filter((s) => !s.deletedAt);
  const insight = analyzeRecurringHealth({
    subscriptions,
    transactions: txnStore.transactions.filter((t) => !t.deletedAt),
  }).find((item) => item.subscriptionId === subscriptionId);

  const next = subsStore.subscriptions.map((sub) => {
    if (sub.id !== subscriptionId) return sub;
    if (data.action === "cancel") return { ...sub, status: "canceled" as const };

    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be positive");
    return {
      ...sub,
      amount: Math.round(amount * 100) / 100,
      lastSeen: insight?.lastChargeAt ?? data.lastSeen ?? sub.lastSeen,
    };
  });

  await saveSubscriptionsImpl({ subscriptions: next });
  return { ok: true };
}

/** Compact household finance snapshot used by the conversational Coach. */
export interface FinanceContext {
  hasFinance: boolean;
  netWorth: number;
  netWorthAsOf: ISODate;
  monthlyTakeHome: number;
  thisMonth: MonthBuckets;
  monthlySubscriptionCost: number;
  activeSubscriptionCount: number;
}

export async function loadFinanceContextImpl(date: ISODate): Promise<FinanceContext> {
  const [snapshotInfo, budget, subs, txns] = await Promise.all([
    loadFinanceSnapshotForHubImpl(date),
    loadBudgetImpl(),
    loadSubscriptionsImpl(),
    loadTransactionsImpl(),
  ]);
  const transactions = txns.transactions.filter((t) => !t.deletedAt);
  const month = date.slice(0, 7);
  const thisMonth = rollupMonth(transactions, month);
  const active = subs.subscriptions.filter((s) => !s.deletedAt && s.status === "active");
  const monthTxns = transactions.filter((t) => monthKey(t.timestamp) === month);
  addUnseenRecurringToBuckets(thisMonth, active, monthTxns);
  const cuttableSubscriptions = active.filter(isCuttableSubscription);
  const monthlySubscriptionCost = cuttableSubscriptions.reduce(
    (sum, subscription) => sum + subscriptionMonthlyCost(subscription),
    0,
  );
  const netWorth = snapshotInfo.snapshot.netWorth;

  return {
    hasFinance:
      netWorth > 0 ||
      transactions.length > 0 ||
      (budget?.monthlyTakeHome ?? 0) > 0 ||
      active.length > 0,
    netWorth,
    netWorthAsOf: snapshotInfo.sourceDate,
    monthlyTakeHome: budget?.monthlyTakeHome ?? thisMonth.income,
    thisMonth,
    monthlySubscriptionCost,
    activeSubscriptionCount: cuttableSubscriptions.length,
  };
}
