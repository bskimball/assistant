import type { CategoryGroup, Subscription, Transaction } from "@/lib/domain";
import { cleanMerchantName, spendAmountOf, spendBucketOf, transactionMerchant } from "@/lib/domain";
import type { MonthBuckets } from "./_shared";
import {
  DAY,
  daysInMonthUTC,
  dollars,
  median,
  monthKey,
  normalizedFinanceLabel,
  positive,
} from "./_shared";
import {
  recurringAdditionsFromItems,
  recurringItemsForMonth,
  recurringMatchesTransaction,
} from "./recurring";

export type OneTimeCandidate = {
  transactionId: string;
  amount: number;
  timestamp: number;
  merchant: string;
  categoryGroup?: CategoryGroup;
  reason: string;
  confidence: number;
};

export type BudgetInsight = {
  planSpend: number;
  committedPlan: number;
  variablePlanSpend: number;
  oneTimeSpend: number;
  oneTimeCount: number;
  plannedRecurring: number;
  totalSpent: number;
  remainingCash: number;
  remainingAfterCommitted: number;
  bucketDeltas: { needs: number; wants: number; savings: number };
  projectedPlanSpend: number | null;
  lines: string[];
  /** Statement plan buckets only (exclude one-time). */
  statementBuckets: { needs: number; wants: number; savings: number };
  /** Unpaid remaining recurring by bucket. */
  unpaidRecurring: { needs: number; wants: number; savings: number };
  /** Statement + unpaid recurring — same totals Budget bars show. */
  bucketTotals: { needs: number; wants: number; savings: number };
  /** moneyIn − moneyOut. moneyOut = planSpend + oneTime + plannedRecurring. */
  moneyIn: number;
  moneyOut: number;
  leftAfterOut: number;
  importedIncome: number;
  usingTakeHome: boolean;
  savingsTarget: number;
  /** Max(0, savingsTarget − posted savings − unpaid savings recurring). */
  savingsTargetRemaining: number;
};

/**
 * Single source of truth for “this month’s money” on Overview and Budget.
 * Identities (always):
 *   bucketTotals.X = statementBuckets.X + unpaidRecurring.X
 *   planSpend = sum(statementBuckets)
 *   plannedRecurring = sum(unpaidRecurring)
 *   committedPlan = planSpend + plannedRecurring = sum(bucketTotals)
 *   moneyOut = planSpend + oneTimeSpend + plannedRecurring
 *            = sum(bucketTotals) + oneTimeSpend
 *   leftAfterOut = moneyIn − moneyOut
 *   remainingAfterCommitted = moneyIn − moneyOut  (when moneyIn uses take-home)
 * Savings *target* is NOT in moneyOut — only posted/scheduled savings transfers are.
 */

export function transactionsForMonth(transactions: Transaction[], month: string): Transaction[] {
  return transactions.filter((t) => monthKey(t.timestamp) === month);
}

// Transactions posted in any month strictly before `month` ("YYYY-MM"). Feeds
// `recurringItemsForMonth`'s prior-charge lookup so pending recurring rows can
// report when they were last paid. "YYYY-MM" keys compare lexicographically.
export function transactionsBeforeMonth(transactions: Transaction[], month: string): Transaction[] {
  return transactions.filter((t) => monthKey(t.timestamp) < month);
}

export function detectOneTimeCandidates(input: {
  transactions: Transaction[];
  subscriptions: Subscription[];
  month: string;
  monthlyTakeHome?: number;
  lookbackDays?: number;
  now?: number;
}): OneTimeCandidate[] {
  const now = input.now ?? Date.now();
  const lookbackStart = now - (input.lookbackDays ?? 180) * DAY;
  const activeSubscriptions = input.subscriptions.filter(
    (sub) => !sub.deletedAt && sub.status === "active",
  );
  const monthTxns = transactionsForMonth(input.transactions, input.month).filter(
    (t) => !t.deletedAt,
  );
  const expenseAbs = monthTxns
    .filter((t) => t.amount < 0 && !t.excludeFromBudget && !!spendBucketOf(t.categoryGroup))
    .map((t) => spendAmountOf(t));
  const fallbackFloor = 3 * median(expenseAbs);
  const sizeFloor = Math.max(
    100,
    input.monthlyTakeHome && input.monthlyTakeHome > 0
      ? 0.04 * input.monthlyTakeHome
      : fallbackFloor,
  );
  const lookbackTxns = input.transactions.filter(
    (t) => !t.deletedAt && t.timestamp >= lookbackStart && t.timestamp <= now,
  );

  return monthTxns
    .flatMap((t): OneTimeCandidate[] => {
      const bucket = spendBucketOf(t.categoryGroup);
      if (!bucket || t.amount >= 0 || t.excludeFromBudget || t.oneTimeSuggestionDismissed)
        return [];
      if (t.recurringId || t.recurringSuggestedId) return [];
      if (activeSubscriptions.some((sub) => recurringMatchesTransaction(sub, t))) return [];

      const merchantKey = normalizedFinanceLabel(transactionMerchant(t));
      if (!merchantKey) return [];
      const merchantMatches = lookbackTxns.filter(
        (candidate) => normalizedFinanceLabel(transactionMerchant(candidate)) === merchantKey,
      );
      const distinctMonths = new Set(
        merchantMatches.map((candidate) => monthKey(candidate.timestamp)),
      );
      if (distinctMonths.size > 1) return [];

      const amount = spendAmountOf(t);
      if (amount < sizeFloor) return [];

      const atLeastDouble = amount >= 2 * sizeFloor;
      const confidence = Math.min(
        0.95,
        0.5 + (atLeastDouble ? 0.2 : 0) + (merchantMatches.length === 1 ? 0.15 : 0),
      );
      return [
        {
          transactionId: t.id,
          amount,
          timestamp: t.timestamp,
          merchant: cleanMerchantName(transactionMerchant(t) || "Unknown merchant"),
          categoryGroup: t.categoryGroup,
          reason: atLeastDouble
            ? "New merchant · 2× size threshold"
            : "New merchant · large charge",
          confidence,
        },
      ];
    })
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);
}

export function buildBudgetInsight(input: {
  transactions: Transaction[];
  subscriptions: Subscription[];
  month: string;
  takeHome: number;
  targets: { needs: number; wants: number; savings: number };
  now?: number;
  /**
   * Prior-month charges for weekly recurring expected-count anchors. When set,
   * remaining recurring matches Budget bars (`recurringItemsForMonth` + prior).
   */
  priorTransactions?: Transaction[];
}): BudgetInsight {
  const now = input.now ?? Date.now();
  const monthTxns = transactionsForMonth(input.transactions, input.month).filter(
    (t) => !t.deletedAt,
  );
  const planBuckets = rollupMonth(monthTxns, input.month);
  // Same remaining-recurring path as Budget bars when prior history is supplied.
  const unpaidRecurring = recurringAdditionsFromItems(
    recurringItemsForMonth(input.subscriptions, monthTxns, input.priorTransactions, input.month),
  );
  const statementBuckets = {
    needs: dollars(planBuckets.needs),
    wants: dollars(planBuckets.wants),
    savings: dollars(planBuckets.savings),
  };
  const plannedRecurring = dollars(
    unpaidRecurring.needs + unpaidRecurring.wants + unpaidRecurring.savings,
  );
  const planSpend = dollars(
    statementBuckets.needs + statementBuckets.wants + statementBuckets.savings,
  );
  const bucketTotals = {
    needs: dollars(statementBuckets.needs + unpaidRecurring.needs),
    wants: dollars(statementBuckets.wants + unpaidRecurring.wants),
    savings: dollars(statementBuckets.savings + unpaidRecurring.savings),
  };
  const activeSubscriptions = input.subscriptions.filter(
    (sub) => !sub.deletedAt && sub.status === "active",
  );
  const variablePlanSpend = dollars(
    monthTxns
      .filter((t) => t.amount < 0 && !t.excludeFromBudget && !!spendBucketOf(t.categoryGroup))
      .filter(
        (t) =>
          !t.recurringId && !activeSubscriptions.some((sub) => recurringMatchesTransaction(sub, t)),
      )
      .reduce((sum, t) => sum + spendAmountOf(t), 0),
  );
  const fixedPlanSpend = dollars(Math.max(0, planSpend - variablePlanSpend));
  const committedPlan = dollars(planSpend + plannedRecurring);
  const oneTimeTxns = monthTxns.filter(
    (t) => t.amount < 0 && t.excludeFromBudget && !!spendBucketOf(t.categoryGroup),
  );
  const oneTimeSpend = dollars(oneTimeTxns.reduce((sum, t) => sum + spendAmountOf(t), 0));
  const totalSpent = dollars(planSpend + oneTimeSpend);
  const takeHome = positive(input.takeHome);
  const actualNeeds = bucketTotals.needs;
  const actualWants = bucketTotals.wants;
  const actualSavings = bucketTotals.savings;
  const bucketDeltas = {
    needs: dollars(actualNeeds - takeHome * input.targets.needs),
    wants: dollars(actualWants - takeHome * input.targets.wants),
    savings: dollars(takeHome * input.targets.savings - actualSavings),
  };
  const importedIncome = dollars(
    monthTxns.filter((t) => t.categoryGroup === "income").reduce((sum, t) => sum + t.amount, 0),
  );
  const usingTakeHome = takeHome > 0;
  const moneyIn = usingTakeHome ? takeHome : importedIncome;
  // moneyOut = plan so far + one-time + unpaid remaining recurring.
  // Equivalent: sum(bucketTotals) + oneTimeSpend.
  const moneyOut = dollars(planSpend + oneTimeSpend + plannedRecurring);
  const leftAfterOut = dollars(moneyIn - moneyOut);
  const savingsTarget = dollars(takeHome * input.targets.savings);
  const savingsTargetRemaining = dollars(
    Math.max(0, savingsTarget - statementBuckets.savings - unpaidRecurring.savings),
  );
  const currentMonth = monthKey(now);
  const dayOfMonth = Math.max(1, new Date(now).getUTCDate());
  const daysInMonth = daysInMonthUTC(now);
  const projectedVariable = dollars((variablePlanSpend / dayOfMonth) * daysInMonth);
  const projectedPlanSpend =
    input.month === currentMonth
      ? dollars(fixedPlanSpend + plannedRecurring + projectedVariable)
      : null;

  const lines: string[] = [];
  if (takeHome > 0) {
    lines.push(
      `Plan so far: $${planSpend.toLocaleString()} (needs + wants + savings contributions) + $${plannedRecurring.toLocaleString()} remaining recurring = $${committedPlan.toLocaleString()} of $${dollars(takeHome).toLocaleString()} take-home.`,
    );
  }
  const projectedVariableExtra = dollars(projectedVariable - variablePlanSpend);
  if (
    projectedPlanSpend !== null &&
    takeHome > 0 &&
    dayOfMonth >= 5 &&
    variablePlanSpend > 0 &&
    projectedVariableExtra > Math.max(50, 0.02 * takeHome)
  ) {
    lines.push(
      projectedPlanSpend > takeHome
        ? `Variable spending is on track to push plan load over take-home (~$${projectedPlanSpend.toLocaleString()} vs $${dollars(takeHome).toLocaleString()}).`
        : `At this pace, variable spending projects to $${projectedVariable.toLocaleString()} this month; total plan load ~$${projectedPlanSpend.toLocaleString()} (take-home $${dollars(takeHome).toLocaleString()}).`,
    );
  }
  if (takeHome > 0) {
    const pressure = [
      { key: "needs", value: bucketDeltas.needs },
      { key: "wants", value: bucketDeltas.wants },
      { key: "savings", value: bucketDeltas.savings },
    ].sort((a, b) => b.value - a.value)[0];
    if (pressure.value > 0) {
      lines.push(
        pressure.key === "needs"
          ? `Needs are $${dollars(pressure.value).toLocaleString()} over plan. Verify bills, loan payments, and one-time charges first.`
          : pressure.key === "wants"
            ? `Wants are $${dollars(pressure.value).toLocaleString()} over plan. Move essentials or mark true one-time charges.`
            : `Savings contributions are $${dollars(pressure.value).toLocaleString()} short of the monthly target. Add or verify an automatic transfer.`,
      );
    } else {
      lines.push("This month is on plan so far. Keep verifying recurring payments as they land.");
    }
  }
  const biggestOneTime = oneTimeTxns.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
  if (biggestOneTime) {
    lines.push(
      `Biggest one-time: ${cleanMerchantName(biggestOneTime.category || biggestOneTime.notes || "Unknown merchant")}, $${dollars(Math.abs(biggestOneTime.amount)).toLocaleString()} — real cash out on Overview, left out of Budget plan bars.`,
    );
  }
  if (bucketDeltas.savings > 0) {
    lines.push(
      `Savings contributions shortfall: $${dollars(bucketDeltas.savings).toLocaleString()} left to hit this month’s target (Overview reserves this; Budget does not).`,
    );
  }

  return {
    planSpend,
    committedPlan,
    variablePlanSpend,
    oneTimeSpend,
    oneTimeCount: oneTimeTxns.length,
    plannedRecurring,
    totalSpent,
    remainingCash: dollars(takeHome - totalSpent),
    remainingAfterCommitted: dollars(takeHome - committedPlan - oneTimeSpend),
    bucketDeltas,
    projectedPlanSpend,
    lines: lines.slice(0, 4),
    statementBuckets,
    unpaidRecurring: {
      needs: dollars(unpaidRecurring.needs),
      wants: dollars(unpaidRecurring.wants),
      savings: dollars(unpaidRecurring.savings),
    },
    bucketTotals,
    moneyIn,
    moneyOut,
    leftAfterOut,
    importedIncome,
    usingTakeHome,
    savingsTarget,
    savingsTargetRemaining,
  };
}

export function rollupMonth(transactions: Transaction[], month: string): MonthBuckets {
  const buckets: MonthBuckets = {
    needs: 0,
    wants: 0,
    savings: 0,
    income: 0,
    month,
  };
  for (const t of transactions) {
    if (t.deletedAt || monthKey(t.timestamp) !== month) continue;
    if (t.excludeFromBudget) continue;
    if (t.categoryGroup === "income") {
      buckets.income += t.amount;
      continue;
    }
    const bucket = spendBucketOf(t.categoryGroup);
    if (bucket) buckets[bucket] += spendAmountOf(t);
  }
  return buckets;
}
