import type { ISODate, Subscription, Transaction } from "@/lib/domain";
import { addDaysISO, toISODate } from "@/lib/domain";
import type { BudgetBucket, BudgetLike, MonthBuckets } from "./_shared";
import {
  addMonthsKey,
  addMonthsToKey,
  dateInMonth,
  daysInMonthUTC,
  dollars,
  positive,
} from "./_shared";
import {
  buildBudgetInsight,
  rollupMonth,
  transactionsBeforeMonth,
  transactionsForMonth,
} from "./budget";
import { recurringAdditionsForMonth } from "./recurring";

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

export type PaySchedule = {
  cadence: "monthly" | "semimonthly" | "biweekly" | "weekly";
  anchorDate?: ISODate;
  payDays?: number[];
};

export type CashFlowCalendarEvent = {
  date: ISODate;
  type: "income" | "commitment";
  label: string;
  /** Positive for income, negative for a commitment. */
  amount: number;
  projectedBalance: number;
};

export type CashFlowCalendarStatus = "healthy" | "tight" | "negative";

export type CashFlowCalendar = {
  todayISO: ISODate;
  horizonDays: number;
  startingCash: number;
  events: CashFlowCalendarEvent[];
  projectedFloor: number;
  projectedFloorDate: ISODate;
  status: CashFlowCalendarStatus;
};

export type CashFlowCalendarInput = {
  todayISO: ISODate;
  /** Number of calendar days to include, beginning with today. */
  horizonDays?: number;
  currentCashBalance: number;
  monthlyTakeHome?: number;
  paySchedule?: PaySchedule;
  subscriptions?: Subscription[];
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

export type SafeToSpendStatus = "unavailable" | "on-track" | "tight" | "over-plan";

/**
 * A monthly budget guardrail, not a statement of available account cash.
 * Account balances, investments, and net worth are intentionally excluded.
 */
export type SafeToSpendResult = {
  status: SafeToSpendStatus;
  monthlyTakeHome: number;
  postedPlanSpend: number;
  upcomingRecurring: number;
  oneTimeSpend: number;
  remainingAfterCommitted: number;
  savingsTarget: number;
  savingsCommitted: number;
  savingsReserve: number;
  safeToSpendThisMonth: number;
  safeToSpendPerDay: number;
  remainingDays: number;
  explanation: string;
};

/**
 * Overview liquidity guardrail: remaining discretionary cash after plan so far
 * (needs + wants + savings contributions), unpaid recurring, one-time cash out,
 * and a reserve for any still-unmet savings target. Budget plan pacing uses
 * `buildBudgetInsight` without this final savings reserve; Overview is tighter
 * on purpose. Composes `buildBudgetInsight` so recurring / exclude rules match.
 */
export function calculateSafeToSpend(input: {
  budget: BudgetLike;
  transactions: Transaction[];
  subscriptions: Subscription[];
  date: string;
}): SafeToSpendResult {
  const [year, monthIndex, day] = input.date.split("-").map(Number);
  const requestedAt = Date.UTC(year, monthIndex - 1, day);
  const daysInMonth = daysInMonthUTC(requestedAt);
  const remainingDays = Math.max(1, daysInMonth - day + 1);
  const monthKeyForDate = input.date.slice(0, 7);

  if (!input.budget || positive(input.budget.monthlyTakeHome) === 0) {
    return {
      status: "unavailable",
      monthlyTakeHome: 0,
      postedPlanSpend: 0,
      upcomingRecurring: 0,
      oneTimeSpend: 0,
      remainingAfterCommitted: 0,
      savingsTarget: 0,
      savingsCommitted: 0,
      savingsReserve: 0,
      safeToSpendThisMonth: 0,
      safeToSpendPerDay: 0,
      remainingDays,
      explanation: "Set monthly take-home pay to calculate this budget guardrail.",
    };
  }

  // Guardrail is "spent so far": only transactions dated on/before the requested
  // day count, so a future-dated current-month charge doesn't pre-spend the plan.
  // (Overview uses the full-month insight instead — a deliberately different view.)
  const transactions = input.transactions.filter(
    (transaction) => toISODate(transaction.timestamp) <= input.date,
  );
  // Same prior-month weekly anchors as the Budget tab so guardrail recurring
  // matches plan bars / Overview cash-out composition.
  const insight = buildBudgetInsight({
    transactions,
    subscriptions: input.subscriptions,
    month: monthKeyForDate,
    takeHome: input.budget.monthlyTakeHome,
    targets: input.budget.targets,
    now: requestedAt,
    priorTransactions: transactionsBeforeMonth(transactions, monthKeyForDate),
  });
  const monthlyTakeHome = dollars(input.budget.monthlyTakeHome);
  const savingsTarget = dollars(monthlyTakeHome * input.budget.targets.savings);
  const savingsCommitted = dollars(Math.max(0, savingsTarget - insight.bucketDeltas.savings));
  const savingsReserve = dollars(Math.max(0, savingsTarget - savingsCommitted));
  const safeToSpendThisMonth = dollars(
    Math.max(0, insight.remainingAfterCommitted - savingsReserve),
  );
  const safeToSpendPerDay = dollars(safeToSpendThisMonth / remainingDays);
  const status: SafeToSpendStatus =
    insight.remainingAfterCommitted < 0
      ? "over-plan"
      : safeToSpendThisMonth <= input.budget.monthlyTakeHome * 0.1
        ? "tight"
        : "on-track";
  const explanation =
    status === "over-plan"
      ? `Plan so far, upcoming recurring, and one-time cash out are $${Math.abs(insight.remainingAfterCommitted).toLocaleString()} over monthly take-home.`
      : safeToSpendThisMonth === 0
        ? `$${insight.remainingAfterCommitted.toLocaleString()} remains after plan so far, upcoming recurring, and one-time cash out, but $${savingsReserve.toLocaleString()} is reserved for the remaining savings target.`
        : `After plan so far, upcoming recurring, one-time cash out, and $${savingsReserve.toLocaleString()} reserved for remaining savings, $${safeToSpendThisMonth.toLocaleString()} remains safe to spend.`;

  return {
    status,
    monthlyTakeHome,
    postedPlanSpend: insight.planSpend,
    upcomingRecurring: insight.plannedRecurring,
    oneTimeSpend: insight.oneTimeSpend,
    remainingAfterCommitted: insight.remainingAfterCommitted,
    savingsTarget,
    savingsCommitted,
    savingsReserve,
    safeToSpendThisMonth,
    safeToSpendPerDay,
    remainingDays,
    explanation,
  };
}

function nextMonthlyDate(date: ISODate, months = 1): ISODate {
  return dateInMonth(addMonthsToKey(date.slice(0, 7), months), Number(date.slice(8, 10)));
}

function paydayDates(
  todayISO: ISODate,
  endISO: ISODate,
  monthlyTakeHome: number,
  schedule?: PaySchedule,
): Array<Omit<CashFlowCalendarEvent, "projectedBalance">> {
  if (positive(monthlyTakeHome) === 0) return [];
  const cadence = schedule?.cadence ?? "monthly";
  const payDays = (schedule?.payDays ?? []).filter(
    (day) => Number.isInteger(day) && day >= 1 && day <= 31,
  );
  const count =
    cadence === "semimonthly"
      ? 2
      : cadence === "biweekly"
        ? 26 / 12
        : cadence === "weekly"
          ? 52 / 12
          : 1;
  const amount = dollars(monthlyTakeHome / count);
  const dates: ISODate[] = [];

  if (cadence === "monthly" || cadence === "semimonthly") {
    // Without configured payday timing, assume monthly take-home lands on the 1st.
    const anchorDay = schedule?.anchorDate ? Number(schedule.anchorDate.slice(8, 10)) : 1;
    const days = [
      ...new Set(payDays.length ? payDays : cadence === "semimonthly" ? [1, 15] : [anchorDay]),
    ];
    for (let monthOffset = 0; ; monthOffset++) {
      const month = addMonthsToKey(todayISO.slice(0, 7), monthOffset);
      if (`${month}-01` > endISO) break;
      for (const day of days) {
        const date = dateInMonth(month, day);
        if (date >= todayISO && date <= endISO) dates.push(date);
      }
    }
  } else {
    const interval = cadence === "weekly" ? 7 : 14;
    let date = schedule?.anchorDate ?? todayISO;
    while (date > todayISO) date = addDaysISO(date, -interval);
    while (date < todayISO) date = addDaysISO(date, interval);
    while (date <= endISO) {
      dates.push(date);
      date = addDaysISO(date, interval);
    }
  }

  return dates.map((date) => ({ date, type: "income", label: "Payday", amount }));
}

function nextCommitmentDate(date: ISODate, cadence: Subscription["cadence"]): ISODate {
  if (cadence === "weekly") return addDaysISO(date, 7);
  if (cadence === "monthly") return nextMonthlyDate(date);
  return nextMonthlyDate(date, 12);
}

/**
 * Project cash/checking/savings through dated paydays and known recurring charges.
 * This is a cash timing view, distinct from the monthly safe-to-spend budget guardrail.
 */
export function calculateCashFlowCalendar(input: CashFlowCalendarInput): CashFlowCalendar {
  const horizonDays = Math.max(1, Math.floor(input.horizonDays ?? 30));
  const endISO = addDaysISO(input.todayISO, horizonDays - 1);
  const events: Array<Omit<CashFlowCalendarEvent, "projectedBalance">> = paydayDates(
    input.todayISO,
    endISO,
    positive(input.monthlyTakeHome),
    input.paySchedule,
  );

  for (const subscription of input.subscriptions ?? []) {
    if (subscription.deletedAt || subscription.status !== "active" || !subscription.nextChargeDate)
      continue;
    let date = subscription.nextChargeDate;
    while (date < input.todayISO) date = nextCommitmentDate(date, subscription.cadence);
    while (date <= endISO) {
      events.push({
        date,
        type: "commitment",
        label: subscription.name,
        amount: -dollars(Math.abs(subscription.amount)),
      });
      date = nextCommitmentDate(date, subscription.cadence);
    }
  }

  events.sort((a, b) =>
    a.date === b.date
      ? a.type === b.type
        ? a.label.localeCompare(b.label)
        : a.type === "income"
          ? -1
          : 1
      : a.date.localeCompare(b.date),
  );

  let balance = dollars(input.currentCashBalance);
  let projectedFloor = balance;
  let projectedFloorDate = input.todayISO;
  const projectedEvents = events.map((event) => {
    balance = dollars(balance + event.amount);
    if (balance < projectedFloor) {
      projectedFloor = balance;
      projectedFloorDate = event.date;
    }
    return { ...event, projectedBalance: balance };
  });
  const tightThreshold = positive(input.monthlyTakeHome) * 0.1;
  const status: CashFlowCalendarStatus =
    projectedFloor < 0 ? "negative" : projectedFloor <= tightThreshold ? "tight" : "healthy";

  return {
    todayISO: input.todayISO,
    horizonDays,
    startingCash: dollars(input.currentCashBalance),
    events: projectedEvents,
    projectedFloor,
    projectedFloorDate,
    status,
  };
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
      ? recurringAdditionsForMonth(subscriptions, monthTxns, month)
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
