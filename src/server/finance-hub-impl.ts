import type { CategoryGroup, ISODate, Transaction, WatchlistId } from "@/lib/domain";
import {
  DEFAULT_BUDGET_TARGETS,
  isCuttableSubscription,
  recurringBudgetBucket,
  spendAmountOf,
  spendBucketOf,
  subscriptionMonthlyCost,
  toISODate,
} from "@/lib/domain";
import { activeTransactions, cashBalance, isActive } from "@/lib/finance-accounts";
import {
  addUnseenRecurringToBuckets,
  analyzeRecurringHealth,
  buildBudgetInsight,
  buildCashFlowProjection,
  calculateCashFlowCalendar,
  calculateEmergencyFund,
  calculateSafeToSpend,
  monthKey,
  recurringAdditionsForMonth,
  rollupMonth,
  transactionsBeforeMonth,
  transactionsForMonth,
  withAutoWatchlist,
  type BudgetBucket,
  type MonthBuckets,
  type WatchlistRuleValue,
} from "@/lib/finance-math";
import {
  loadBudgetImpl,
  loadCategoryRulesImpl,
  loadLatestDailyFinanceImpl,
  loadSubscriptionsImpl,
  loadTransactionsImpl,
  saveSubscriptionsImpl,
  type DailyFinancePayload,
} from "@/server/domain-impl";
import type { FinanceHubPayload } from "@/lib/finance-types";

export type { FinanceHubPayload } from "@/lib/finance-types";

/** Load the most recent finance snapshot on or before the requested day. */
export async function loadFinanceSnapshotForHubImpl(
  day: ISODate,
): Promise<{ snapshot: DailyFinancePayload; sourceDate: ISODate }> {
  return loadLatestDailyFinanceImpl(day);
}

/**
 * Preview watchlist labels for the current month without writing the ledger.
 * Persistence only happens on import/sync or explicit user correction — hub reads
 * must never rewrite transactions.json (that can race and thrash budget views).
 */
function withWatchlistPreview(
  transactions: Transaction[],
  month: string,
  rules: Record<string, WatchlistRuleValue | CategoryGroup>,
): Transaction[] {
  return transactions.map((t) => {
    if (t.deletedAt || monthKey(t.timestamp) !== month) return t;
    const next = withAutoWatchlist(t, rules);
    // Guard: watchlist preview may only touch watchlist fields.
    if (
      next.categoryGroup !== t.categoryGroup ||
      next.amount !== t.amount ||
      next.excludeFromBudget !== t.excludeFromBudget
    ) {
      return {
        ...t,
        watchlistId: next.watchlistId as WatchlistId | undefined,
        watchlistSource: next.watchlistSource,
      };
    }
    return next;
  });
}

/** Assemble the Finance Hub's single read payload. */
export async function loadFinanceHubImpl(day: ISODate): Promise<FinanceHubPayload> {
  const [snapshotInfo, budget, subs, txns, rulesStore] = await Promise.all([
    loadFinanceSnapshotForHubImpl(day),
    loadBudgetImpl(),
    loadSubscriptionsImpl(),
    loadTransactionsImpl(),
    loadCategoryRulesImpl(),
  ]);
  const month = day.slice(0, 7);
  // In-memory only: never CAS-write the ledger on a read path.
  const previewed = withWatchlistPreview(txns.transactions, month, rulesStore.rules);
  const subscriptions = subs.subscriptions.filter(isActive);
  const transactions = activeTransactions(previewed);
  const deletedTransactions = previewed.filter((t) => !isActive(t));

  // Single current-month budget insight for Overview + safe-to-spend (must match
  // calculateSafeToSpend's internal construction when insight is omitted).
  const [year, monthIndex, dayNum] = day.split("-").map(Number);
  const requestedAt = Date.UTC(year, monthIndex - 1, dayNum);
  const insightTransactions = transactions.filter(
    (transaction) => toISODate(transaction.timestamp) <= day,
  );
  const targets = budget?.targets ?? DEFAULT_BUDGET_TARGETS;
  const budgetInsight = buildBudgetInsight({
    transactions: insightTransactions,
    subscriptions,
    month,
    takeHome: budget?.monthlyTakeHome ?? 0,
    targets,
    now: requestedAt,
    priorTransactions: transactionsBeforeMonth(insightTransactions, month),
  });

  // Cash-flow projection input assembly — mirrored from former CashFlowProjectionCard.
  const startMonth = day.slice(0, 7);
  const cashOnHand = cashBalance(snapshotInfo.snapshot.accounts);
  const monthTxns = transactionsForMonth(transactions, startMonth);
  const takeHome =
    budget?.monthlyTakeHome ??
    monthTxns
      .filter((t) => t.amount > 0 && t.categoryGroup === "income")
      .reduce((sum, t) => sum + t.amount, 0);
  const buckets: Record<BudgetBucket, number> = {
    needs: 0,
    wants: 0,
    savings: 0,
  };
  for (const t of monthTxns) {
    if (t.excludeFromBudget) continue;
    const bucket = spendBucketOf(t.categoryGroup);
    if (bucket) buckets[bucket] += spendAmountOf(t);
  }
  const recurring = recurringAdditionsForMonth(subscriptions, monthTxns, startMonth);
  const monthlyBuckets =
    takeHome > 0
      ? {
          needs: Math.max(buckets.needs + recurring.needs, takeHome * targets.needs),
          wants: Math.max(buckets.wants + recurring.wants, takeHome * targets.wants),
          savings: Math.max(buckets.savings + recurring.savings, takeHome * targets.savings),
        }
      : {
          needs: buckets.needs + recurring.needs,
          wants: buckets.wants + recurring.wants,
          savings: buckets.savings + recurring.savings,
        };
  const cashFlowProjection = buildCashFlowProjection({
    startMonth,
    months: 12,
    transactions,
    subscriptions,
    startingCash: cashOnHand,
    monthlyIncome: takeHome,
    monthlyBuckets,
    includeRecurringCommitments: false,
  });

  // Emergency fund — mirrored from former OverviewTab assembly.
  // Prefer budget take-home (0 when unset), matching overview.tsx not the projection path.
  const emergencyTakeHome = budget?.monthlyTakeHome ?? 0;
  const monthlyEssentialExpenses = Math.max(
    budgetInsight.bucketTotals.needs,
    emergencyTakeHome > 0 ? emergencyTakeHome * targets.needs : 0,
  );
  const cashFlow = budgetInsight.leftAfterOut;
  const recurringSavingsMonthly = subscriptions
    .filter((s) => s.status === "active" && recurringBudgetBucket(s) === "savings")
    .reduce((sum, s) => sum + subscriptionMonthlyCost(s), 0);
  const emergencyContribution = Math.max(0, cashFlow, recurringSavingsMonthly);
  const emergencyFund = calculateEmergencyFund({
    monthlyEssentialExpenses,
    currentSavings: cashOnHand,
    monthlyContribution: emergencyContribution,
  });

  return {
    snapshot: snapshotInfo.snapshot,
    snapshotSourceDate: snapshotInfo.sourceDate,
    budget,
    subscriptions,
    transactions,
    deletedTransactions,
    recurringInsights: analyzeRecurringHealth({ subscriptions, transactions: txns.transactions }),
    budgetInsight,
    safeToSpend: calculateSafeToSpend({
      budget,
      subscriptions,
      transactions,
      date: day,
      insight: budgetInsight,
    }),
    cashFlowCalendar: calculateCashFlowCalendar({
      todayISO: day,
      // Unified with client cashBalance: cash accounts only, positive balances.
      // Formerly an inline dual-regex filter; classifyAccount owns the keywords now.
      currentCashBalance: cashOnHand,
      monthlyTakeHome: budget?.monthlyTakeHome,
      paySchedule: budget?.paySchedule,
      subscriptions,
    }),
    cashFlowProjection,
    emergencyFund,
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
  const subscriptions = subsStore.subscriptions.filter(isActive);
  const insight = analyzeRecurringHealth({
    subscriptions,
    transactions: txnStore.transactions,
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
  const transactions = activeTransactions(txns.transactions);
  const month = date.slice(0, 7);
  const thisMonth = rollupMonth(transactions, month);
  const active = subs.subscriptions.filter((s) => isActive(s) && s.status === "active");
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
