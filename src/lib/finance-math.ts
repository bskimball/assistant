import type { FinanceAdviceItem, Subscription, Transaction, UserProfile } from "@/lib/domain";
import {
  cleanMerchantName,
  DEFAULT_BUDGET_TARGETS,
  recurringBudgetBucket,
  recurringKindOf,
  spendBucketOf,
  subscriptionMonthlyCost,
} from "@/lib/domain";

export type BudgetBucket = "needs" | "wants" | "savings";

export interface MonthBuckets {
  needs: number;
  wants: number;
  savings: number;
  income: number;
  month: string;
}

export type CashFlowProjectionInput = {
  startMonth: string;
  months: number;
  transactions?: Transaction[];
  subscriptions?: Subscription[];
  startingCash?: number;
  monthlyIncome?: number;
  monthlyBuckets?: Partial<Record<BudgetBucket, number>>;
  includeRecurringCommitments?: boolean;
};

export type CashFlowProjectionMonth = MonthBuckets & {
  recurringNeeds: number;
  recurringWants: number;
  recurringSavings: number;
  totalOutflow: number;
  netCashFlow: number;
  startingCash: number;
  endingCash: number;
};

export type CashFlowProjection = {
  startMonth: string;
  months: CashFlowProjectionMonth[];
  endingCash: number;
  totalIncome: number;
  totalOutflow: number;
  totalNetCashFlow: number;
};

export type DebtPayoffStrategy = "avalanche" | "snowball" | "input-order";

export type DebtPayoffDebt = {
  id: string;
  name: string;
  balance: number;
  apr?: number;
  minimumPayment: number;
};

export type DebtPayoffInput = {
  debts: DebtPayoffDebt[];
  extraMonthlyPayment?: number;
  strategy?: DebtPayoffStrategy;
  maxMonths?: number;
};

export type DebtPayoffMonth = {
  month: number;
  beginningBalance: number;
  interest: number;
  principal: number;
  payment: number;
  endingBalance: number;
  targetDebtId?: string;
};

export type DebtPayoffDebtResult = DebtPayoffDebt & {
  monthsToPayoff: number | null;
  totalInterest: number;
  totalPaid: number;
};

export type DebtPayoffSimulation = {
  strategy: DebtPayoffStrategy;
  months: number | null;
  totalInterest: number;
  totalPaid: number;
  payoffOrder: string[];
  debts: DebtPayoffDebtResult[];
  schedule: DebtPayoffMonth[];
  feasible: boolean;
};

export type EmergencyFundInput = {
  monthlyEssentialExpenses: number;
  currentSavings?: number;
  targetMonths?: number;
  minimumMonths?: number;
  monthlyContribution?: number;
};

export type EmergencyFundResult = {
  monthlyEssentialExpenses: number;
  minimumTarget: number;
  target: number;
  currentSavings: number;
  shortfall: number;
  surplus: number;
  monthsCovered: number;
  monthsToTarget: number | null;
  status: "not-started" | "building" | "funded" | "surplus";
};

export type BudgetRecurringItem = {
  id: string;
  name: string;
  kind: ReturnType<typeof recurringKindOf>;
  bucket: BudgetBucket;
  cadence: Subscription["cadence"];
  monthlyAmount: number;
  account?: string;
  seenThisMonth: boolean;
  matchedCount: number;
  matchedAmount: number;
  expectedThisMonth: number;
  remainingMonthlyAmount: number;
  /**
   * The best matching charge for this item in the month (most recent when
   * several match). Its presence is what defines `seenThisMonth`. `amount` is
   * the raw signed transaction amount (negative for a charge).
   */
  matchedTxn?: { timestamp: number; amount: number; account?: string };
};

const DAY = 24 * 60 * 60 * 1000;

type BudgetLike = {
  monthlyTakeHome: number;
  targets: { needs: number; wants: number; savings: number };
} | null;

function dollars(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

function positive(n: number | undefined): number {
  return Number.isFinite(n) && n && n > 0 ? n : 0;
}

function addMonthsKey(month: string, offset: number): string {
  const [year, monthIndex] = month.split("-").map(Number);
  if (!year || !monthIndex) return month;
  return new Date(Date.UTC(year, monthIndex - 1 + offset, 1)).toISOString().slice(0, 7);
}

export function monthKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

export function normalizedFinanceLabel(raw?: string): string {
  return cleanMerchantName(raw || "").toLowerCase();
}

export function recurringMatchesTransaction(sub: Subscription, t: Transaction): boolean {
  if (t.amount >= 0) return false;
  const amount = Math.abs(t.amount);
  const amountMatches = Math.abs(amount - sub.amount) <= Math.max(1, sub.amount * 0.05);
  if (!amountMatches) return false;

  const subName = normalizedFinanceLabel(sub.name);
  const txnName = normalizedFinanceLabel(t.category || t.notes || "");
  const nameMatches =
    !!subName && !!txnName && (txnName.includes(subName) || subName.includes(txnName));
  const accountMatches =
    !!sub.account &&
    !!t.account &&
    sub.account.trim().toLowerCase() === t.account.trim().toLowerCase();
  const rawTxnDescriptor = [t.category, t.notes].filter(Boolean).join(" ").toLowerCase();
  const hintMatches = (sub.matchHints ?? []).some((hint) => {
    const normalizedHint = hint.trim().toLowerCase();
    return !!normalizedHint && rawTxnDescriptor.includes(normalizedHint);
  });
  return amountMatches && (nameMatches || accountMatches || hintMatches);
}

export function transactionsForMonth(transactions: Transaction[], month: string): Transaction[] {
  return transactions.filter((t) => monthKey(t.timestamp) === month);
}

export function buildCashFlowProjection(input: CashFlowProjectionInput): CashFlowProjection {
  const projectionMonths = Math.max(0, Math.floor(input.months));
  const transactions = input.transactions ?? [];
  const subscriptions = input.subscriptions ?? [];
  const includeRecurring = input.includeRecurringCommitments ?? true;
  let runningCash = dollars(input.startingCash ?? 0);
  const months: CashFlowProjectionMonth[] = [];

  for (let i = 0; i < projectionMonths; i++) {
    const month = addMonthsKey(input.startMonth, i);
    const monthTxns = transactionsForMonth(transactions, month).filter((t) => !t.deletedAt);
    const rolled = rollupMonth(monthTxns, month);
    const income = dollars(input.monthlyIncome ?? rolled.income);
    const needs = dollars(input.monthlyBuckets?.needs ?? rolled.needs);
    const wants = dollars(input.monthlyBuckets?.wants ?? rolled.wants);
    const savings = dollars(input.monthlyBuckets?.savings ?? rolled.savings);
    const recurring = includeRecurring
      ? recurringAdditionsForMonth(subscriptions, monthTxns)
      : { needs: 0, wants: 0, savings: 0 };
    const recurringNeeds = dollars(recurring.needs);
    const recurringWants = dollars(recurring.wants);
    const recurringSavings = dollars(recurring.savings);
    const totalOutflow = dollars(
      needs + wants + savings + recurringNeeds + recurringWants + recurringSavings,
    );
    const netCashFlow = dollars(income - totalOutflow);
    const startingCash = runningCash;
    runningCash = dollars(runningCash + netCashFlow);
    months.push({
      month,
      income,
      needs,
      wants,
      savings,
      recurringNeeds,
      recurringWants,
      recurringSavings,
      totalOutflow,
      netCashFlow,
      startingCash,
      endingCash: runningCash,
    });
  }

  const totalIncome = dollars(months.reduce((sum, m) => sum + m.income, 0));
  const totalOutflow = dollars(months.reduce((sum, m) => sum + m.totalOutflow, 0));
  const totalNetCashFlow = dollars(months.reduce((sum, m) => sum + m.netCashFlow, 0));

  return {
    startMonth: input.startMonth,
    months,
    endingCash: runningCash,
    totalIncome,
    totalOutflow,
    totalNetCashFlow,
  };
}

export function rollupMonth(transactions: Transaction[], month: string): MonthBuckets {
  const buckets: MonthBuckets = { needs: 0, wants: 0, savings: 0, income: 0, month };
  for (const t of transactions) {
    if (t.deletedAt || monthKey(t.timestamp) !== month) continue;
    if (t.excludeFromBudget) continue;
    if (t.categoryGroup === "income") {
      buckets.income += Math.abs(t.amount);
      continue;
    }
    const bucket = spendBucketOf(t.categoryGroup);
    if (bucket) buckets[bucket] += Math.abs(t.amount);
  }
  return buckets;
}

function expectedPaymentsForMonth(cadence: Subscription["cadence"]): number {
  if (cadence === "weekly") return 4;
  if (cadence === "monthly") return 1;
  return 0;
}

function remainingRecurringAmount(
  sub: Subscription,
  monthlyAmount: number,
  matchedAmount: number,
  seenThisMonth: boolean,
): number {
  if (sub.cadence === "weekly") return Math.max(0, monthlyAmount - matchedAmount);
  return seenThisMonth ? 0 : monthlyAmount;
}

export function recurringItemsForMonth(
  subscriptions: Subscription[],
  monthTxns: Transaction[],
): Record<BudgetBucket, BudgetRecurringItem[]> {
  const items: Record<BudgetBucket, BudgetRecurringItem[]> = { needs: [], wants: [], savings: [] };
  for (const sub of subscriptions) {
    if (sub.status !== "active") continue;
    const bucket = recurringBudgetBucket(sub);
    // Best matching charge this month: when several match, keep the most recent
    // so the row reports the latest payment. seenThisMonth derives from it.
    const matches = monthTxns.filter((t) => recurringMatchesTransaction(sub, t));
    const matched = matches.reduce<Transaction | null>(
      (best, t) => (!best || t.timestamp > best.timestamp ? t : best),
      null,
    );
    const monthlyAmount = subscriptionMonthlyCost(sub);
    const matchedAmount = matches.reduce((sum, t) => sum + Math.abs(t.amount), 0);
    const seenThisMonth = matched !== null;
    items[bucket].push({
      id: sub.id,
      name: sub.name,
      kind: recurringKindOf(sub),
      bucket,
      cadence: sub.cadence,
      monthlyAmount,
      account: sub.account,
      seenThisMonth,
      matchedCount: matches.length,
      matchedAmount,
      expectedThisMonth: expectedPaymentsForMonth(sub.cadence),
      remainingMonthlyAmount: remainingRecurringAmount(
        sub,
        monthlyAmount,
        matchedAmount,
        seenThisMonth,
      ),
      matchedTxn: matched
        ? { timestamp: matched.timestamp, amount: matched.amount, account: matched.account }
        : undefined,
    });
  }
  for (const bucket of ["needs", "wants", "savings"] as const) {
    items[bucket].sort((a, b) => b.monthlyAmount - a.monthlyAmount);
  }
  return items;
}

export function recurringAdditionsFromItems(
  items: Record<BudgetBucket, BudgetRecurringItem[]>,
): Record<BudgetBucket, number> {
  return {
    needs: items.needs.reduce((sum, item) => sum + item.remainingMonthlyAmount, 0),
    wants: items.wants.reduce((sum, item) => sum + item.remainingMonthlyAmount, 0),
    savings: items.savings.reduce((sum, item) => sum + item.remainingMonthlyAmount, 0),
  };
}

export function recurringAdditionsForMonth(
  subscriptions: Subscription[],
  monthTxns: Transaction[],
): Record<BudgetBucket, number> {
  return recurringAdditionsFromItems(recurringItemsForMonth(subscriptions, monthTxns));
}

export function addUnseenRecurringToBuckets(
  buckets: Pick<MonthBuckets, BudgetBucket>,
  subscriptions: Subscription[],
  monthTxns: Transaction[],
): Record<BudgetBucket, number> {
  const additions = recurringAdditionsForMonth(subscriptions, monthTxns);
  buckets.needs += additions.needs;
  buckets.wants += additions.wants;
  buckets.savings += additions.savings;
  return additions;
}

function debtPriority(
  a: DebtPayoffDebt,
  b: DebtPayoffDebt,
  strategy: DebtPayoffStrategy,
  order: Map<string, number>,
): number {
  if (strategy === "avalanche") {
    const aprDelta = positive(b.apr) - positive(a.apr);
    if (aprDelta !== 0) return aprDelta;
  } else if (strategy === "snowball") {
    const balanceDelta = positive(a.balance) - positive(b.balance);
    if (balanceDelta !== 0) return balanceDelta;
  }
  return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
}

export function simulateDebtPayoff(input: DebtPayoffInput): DebtPayoffSimulation {
  const strategy = input.strategy ?? "avalanche";
  const maxMonths = Math.max(1, Math.floor(input.maxMonths ?? 600));
  const extraMonthlyPayment = positive(input.extraMonthlyPayment);
  const order = new Map(input.debts.map((d, index) => [d.id, index]));
  const states = input.debts
    .filter((d) => positive(d.balance) > 0)
    .map((d) => ({
      debt: {
        ...d,
        balance: dollars(positive(d.balance)),
        apr: positive(d.apr),
        minimumPayment: dollars(positive(d.minimumPayment)),
      },
      balance: dollars(positive(d.balance)),
      totalInterest: 0,
      totalPaid: 0,
      monthsToPayoff: null as number | null,
    }));
  const schedule: DebtPayoffMonth[] = [];
  const payoffOrder: string[] = [];

  if (!states.length) {
    return {
      strategy,
      months: 0,
      totalInterest: 0,
      totalPaid: 0,
      payoffOrder,
      debts: [],
      schedule,
      feasible: true,
    };
  }

  for (let month = 1; month <= maxMonths; month++) {
    const active = states.filter((s) => s.balance > 0);
    if (!active.length) break;
    const target = [...active].sort((a, b) => debtPriority(a.debt, b.debt, strategy, order))[0];
    let extraPool = extraMonthlyPayment;

    for (const state of active) {
      const beginningBalance = state.balance;
      const monthlyRate = positive(state.debt.apr) / 100 / 12;
      const interest = dollars(beginningBalance * monthlyRate);
      const balanceWithInterest = dollars(beginningBalance + interest);
      const scheduledPayment = dollars(Math.min(balanceWithInterest, state.debt.minimumPayment));
      state.balance = dollars(balanceWithInterest - scheduledPayment);
      state.totalInterest = dollars(state.totalInterest + interest);
      state.totalPaid = dollars(state.totalPaid + scheduledPayment);
      schedule.push({
        month,
        beginningBalance,
        interest,
        principal: dollars(scheduledPayment - interest),
        payment: scheduledPayment,
        endingBalance: state.balance,
        targetDebtId: target?.debt.id,
      });
    }

    while (extraPool > 0) {
      const extraTarget = [...states]
        .filter((s) => s.balance > 0)
        .sort((a, b) => debtPriority(a.debt, b.debt, strategy, order))[0];
      if (!extraTarget) break;
      const extraPayment = dollars(Math.min(extraPool, extraTarget.balance));
      extraTarget.balance = dollars(extraTarget.balance - extraPayment);
      extraTarget.totalPaid = dollars(extraTarget.totalPaid + extraPayment);
      extraPool = dollars(extraPool - extraPayment);
      schedule.push({
        month,
        beginningBalance: dollars(extraTarget.balance + extraPayment),
        interest: 0,
        principal: extraPayment,
        payment: extraPayment,
        endingBalance: extraTarget.balance,
        targetDebtId: extraTarget.debt.id,
      });
      if (extraTarget.balance === 0 && extraTarget.monthsToPayoff === null) {
        extraTarget.monthsToPayoff = month;
        payoffOrder.push(extraTarget.debt.id);
      }
    }

    for (const state of states) {
      if (state.balance === 0 && state.monthsToPayoff === null) {
        state.monthsToPayoff = month;
        payoffOrder.push(state.debt.id);
      }
    }

    const impossible = states.some((s) => {
      const monthlyRate = positive(s.debt.apr) / 100 / 12;
      return s.balance > 0 && s.debt.minimumPayment <= dollars(s.balance * monthlyRate);
    });
    if (impossible && extraMonthlyPayment === 0) break;
  }

  const feasible = states.every((s) => s.balance === 0);
  const paidMonths = states.map((s) => s.monthsToPayoff ?? 0);
  const months = feasible ? Math.max(...paidMonths) : null;
  const debts = states.map((s) => ({
    ...s.debt,
    monthsToPayoff: s.monthsToPayoff,
    totalInterest: dollars(s.totalInterest),
    totalPaid: dollars(s.totalPaid),
  }));
  const totalInterest = dollars(debts.reduce((sum, d) => sum + d.totalInterest, 0));
  const totalPaid = dollars(debts.reduce((sum, d) => sum + d.totalPaid, 0));

  return {
    strategy,
    months,
    totalInterest,
    totalPaid,
    payoffOrder,
    debts,
    schedule,
    feasible,
  };
}

export function calculateEmergencyFund(input: EmergencyFundInput): EmergencyFundResult {
  const monthlyEssentialExpenses = dollars(positive(input.monthlyEssentialExpenses));
  const currentSavings = dollars(positive(input.currentSavings));
  const minimumMonths = positive(input.minimumMonths) || 3;
  const targetMonths = Math.max(minimumMonths, positive(input.targetMonths) || 6);
  const monthlyContribution = dollars(positive(input.monthlyContribution));
  const minimumTarget = dollars(monthlyEssentialExpenses * minimumMonths);
  const target = dollars(monthlyEssentialExpenses * targetMonths);
  const shortfall = dollars(Math.max(0, target - currentSavings));
  const surplus = dollars(Math.max(0, currentSavings - target));
  const monthsCovered =
    monthlyEssentialExpenses > 0 ? dollars(currentSavings / monthlyEssentialExpenses) : 0;
  const monthsToTarget =
    shortfall === 0
      ? 0
      : monthlyContribution > 0
        ? Math.ceil(shortfall / monthlyContribution)
        : null;
  const status =
    surplus > 0
      ? "surplus"
      : currentSavings >= target
        ? "funded"
        : currentSavings >= minimumTarget
          ? "building"
          : "not-started";

  return {
    monthlyEssentialExpenses,
    minimumTarget,
    target,
    currentSavings,
    shortfall,
    surplus,
    monthsCovered,
    monthsToTarget,
    status,
  };
}

export function fallbackFinanceAdvice(args: {
  budget: BudgetLike;
  buckets: MonthBuckets;
  subscriptions: Subscription[];
  netWorth: number;
  profile: UserProfile;
  /** Active loans (for a highest-APR payoff/refinance note). Optional. */
  loans?: Subscription[];
  /** Idle cash-like balance across accounts, for an emergency-fund note. Optional. */
  cashOnHand?: number;
}): FinanceAdviceItem[] {
  const { budget, buckets, subscriptions, netWorth, profile, loans = [], cashOnHand } = args;
  const items: FinanceAdviceItem[] = [];
  const takeHome = budget?.monthlyTakeHome ?? buckets.income;
  const targets = budget?.targets ?? DEFAULT_BUDGET_TARGETS;

  if (takeHome > 0) {
    const checks: { bucket: BudgetBucket; actual: number }[] = [
      { bucket: "needs", actual: buckets.needs },
      { bucket: "wants", actual: buckets.wants },
      { bucket: "savings", actual: buckets.savings },
    ];
    for (const { bucket, actual } of checks) {
      const targetPct = targets[bucket];
      const actualPct = actual / takeHome;
      if (bucket === "wants" && actualPct > targetPct + 0.05) {
        items.push({
          category: "budget",
          text: `Wants spending is ${Math.round(actualPct * 100)}% of take-home vs a ${Math.round(targetPct * 100)}% target — about $${Math.round((actualPct - targetPct) * takeHome).toLocaleString()} over. Trim the two largest discretionary categories.`,
          action: "Review top wants spending",
        });
      }
      if (bucket === "savings" && actualPct < targetPct - 0.03) {
        items.push({
          category: "budget",
          text: `Savings rate is ${Math.round(actualPct * 100)}% vs a ${Math.round(targetPct * 100)}% target. Automate a transfer of $${Math.round((targetPct - actualPct) * takeHome).toLocaleString()}/mo to close the gap.`,
          action: "Automate savings transfer",
        });
      }
    }
  } else {
    items.push({
      category: "budget",
      text: "Set your monthly take-home pay and import a statement to see your real 50/30/20 breakdown.",
      action: "Set take-home pay",
    });
  }

  const active = subscriptions.filter((s) => s.status === "active");
  if (active.length) {
    const monthlyTotal = active.reduce((s, x) => s + subscriptionMonthlyCost(x), 0);
    const stale = active.filter((s) => s.lastSeen && Date.now() - s.lastSeen > 75 * DAY);
    const largest = active.reduce((a, b) =>
      subscriptionMonthlyCost(b) > subscriptionMonthlyCost(a) ? b : a,
    );
    const largestCost = subscriptionMonthlyCost(largest);
    items.push({
      category: "subscriptions",
      text: `You're carrying ${active.length} cuttable subscriptions totaling ~$${Math.round(monthlyTotal).toLocaleString()}/mo ($${Math.round(monthlyTotal * 12).toLocaleString()}/yr). The largest is ${largest.name} at ~$${Math.round(largestCost).toLocaleString()}/mo — cutting just that saves $${Math.round(largestCost * 12).toLocaleString()}/yr.${stale.length ? ` ${stale.length} haven't charged in 75+ days — cancel candidates.` : ""}`,
      action: `Cut ${largest.name}`,
    });
  }

  // Highest-APR loan: a payoff/refinance nudge grounded in the actual rate.
  const activeLoans = loans.filter((s) => s.status === "active" && (s.apr ?? 0) > 0);
  if (activeLoans.length) {
    const worst = activeLoans.reduce((a, b) => ((b.apr ?? 0) > (a.apr ?? 0) ? b : a));
    const payment = subscriptionMonthlyCost(worst);
    const balanceNote = worst.balance
      ? ` on a $${Math.round(worst.balance).toLocaleString()} balance`
      : "";
    items.push({
      category: "budget",
      text: `${worst.name} carries the highest rate at ${worst.apr}% APR${balanceNote} (~$${Math.round(payment).toLocaleString()}/mo). ${(worst.apr ?? 0) >= 7 ? "Refinancing or throwing surplus at this beats most guaranteed returns." : "Keep paying as scheduled; the rate is low enough not to rush."}`,
      action: (worst.apr ?? 0) >= 7 ? `Target ${worst.name} payoff` : "Review loan rate",
    });
  }

  // Idle cash: money sitting in checking beyond a healthy emergency buffer is
  // an opportunity cost. Compare cash-like balances to ~6 months of needs.
  // buckets.needs is only month-to-date, so mid-month it understates a full
  // month — use the 50/30/20 needs target as a floor when take-home is known.
  const monthlyNeeds = Math.max(buckets.needs, takeHome > 0 ? takeHome * targets.needs : 0);
  if (typeof cashOnHand === "number" && cashOnHand > 0 && monthlyNeeds > 0) {
    const sixMonths = monthlyNeeds * 6;
    if (cashOnHand > sixMonths) {
      const idle = cashOnHand - sixMonths;
      items.push({
        category: "investing",
        text: `You're holding ~$${Math.round(cashOnHand).toLocaleString()} in cash — about $${Math.round(idle).toLocaleString()} above a 6-month ($${Math.round(sixMonths).toLocaleString()}) emergency fund. Consider moving the excess into your risk-appropriate index allocation or a high-yield account so it isn't losing to inflation.`,
        action: "Deploy idle cash",
      });
    }
  }

  const riskNote =
    profile.riskTolerance === "aggressive"
      ? "Given your aggressive risk tolerance, keep a high equity allocation but make sure you hold 3-6 months of expenses in cash first."
      : profile.riskTolerance === "conservative"
        ? "With a conservative profile, prioritize an emergency fund and broad low-cost index funds over individual picks."
        : "Favor broad low-cost index funds; increase 401k contribution at least to any employer match.";
  items.push({
    category: "investing",
    text: `${riskNote} Max free money first: confirm you're capturing your full ADP 401k match.`,
    action: "Check 401k match",
  });

  const surplus = takeHome > 0 ? takeHome - buckets.needs - buckets.wants - buckets.savings : 0;
  const targetSavings = takeHome > 0 ? takeHome * targets.savings : 0;
  const savingsGap = Math.max(0, targetSavings - buckets.savings);
  const profileGoalGap = profile.monthlySavingsGoal
    ? Math.max(0, profile.monthlySavingsGoal - buckets.savings)
    : 0;
  const revenueTarget = Math.max(
    savingsGap,
    profileGoalGap,
    takeHome > 0 ? takeHome * 0.05 : 250,
    250,
  );
  const skillList = profile.skills?.length ? profile.skills : undefined;
  const skillNote = skillList
    ? ` Build it on a skill you can already sell (${skillList.slice(0, 2).join(", ")}) — e.g. a productized ${skillList[0]} offer or a fixed-scope audit.`
    : profile.goals?.length
      ? ` Leverage what you already do (${profile.goals.slice(0, 2).join(", ")}).`
      : " Pick one measurable lane: raise/client-rate conversation, consulting audit, or productized skill offer.";
  items.push({
    category: "earn",
    text: `Run a $${Math.round(revenueTarget).toLocaleString()}/mo revenue experiment to accelerate net worth (currently $${netWorth.toLocaleString()}).${surplus > 0 ? ` You have ~$${Math.round(surplus).toLocaleString()}/mo of surplus to seed it.` : ""}${skillNote}`,
    action: skillList ? `Sell ${skillList[0]}` : "Start revenue experiment",
  });

  return items;
}
