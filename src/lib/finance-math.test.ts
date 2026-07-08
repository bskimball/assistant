import { describe, expect, it } from "vitest";
import type { Subscription, Transaction, UserProfile } from "@/lib/domain";
import {
  addUnseenRecurringToBuckets,
  buildCashFlowProjection,
  calculateEmergencyFund,
  fallbackFinanceAdvice,
  recurringItemsForMonth,
  recurringMatchesTransaction,
  rollupMonth,
  simulateDebtPayoff,
  transactionsForMonth,
} from "@/lib/finance-math";

const jan = Date.UTC(2026, 0, 15);
const feb = Date.UTC(2026, 1, 1);

function txn(partial: Partial<Transaction>): Transaction {
  return {
    id: partial.id ?? "txn",
    createdAt: partial.createdAt ?? jan,
    timestamp: partial.timestamp ?? jan,
    type: partial.type ?? (partial.amount && partial.amount > 0 ? "deposit" : "withdrawal"),
    amount: partial.amount ?? -10,
    currency: partial.currency ?? "USD",
    category: partial.category ?? "Vendor",
    categoryGroup: partial.categoryGroup ?? "wants",
    account: partial.account,
    notes: partial.notes,
    excludeFromBudget: partial.excludeFromBudget,
    deletedAt: partial.deletedAt,
  };
}

function sub(partial: Partial<Subscription>): Subscription {
  return {
    id: partial.id ?? "sub",
    createdAt: partial.createdAt ?? jan,
    name: partial.name ?? "Netflix",
    amount: partial.amount ?? 15,
    cadence: partial.cadence ?? "monthly",
    status: partial.status ?? "active",
    source: partial.source ?? "manual",
    account: partial.account,
    kind: partial.kind,
    group: partial.group,
    lastSeen: partial.lastSeen,
    balance: partial.balance,
    apr: partial.apr,
    matchHints: partial.matchHints,
  };
}

describe("finance math", () => {
  it("matches recurring subscriptions by normalized name or account plus amount", () => {
    expect(
      recurringMatchesTransaction(
        sub({ name: "Netflix", amount: 15 }),
        txn({ amount: -15.49, category: "NETFLIX.COM" }),
      ),
    ).toBe(true);
    expect(
      recurringMatchesTransaction(
        sub({ name: "Gym", amount: 20, account: "Checking" }),
        txn({ amount: -20, category: "Unknown charge", account: "checking" }),
      ),
    ).toBe(true);
    expect(
      recurringMatchesTransaction(
        sub({ name: "Netflix", amount: 15 }),
        txn({ amount: -25, category: "NETFLIX.COM" }),
      ),
    ).toBe(false);
  });

  it("matches recurring subscriptions by raw descriptor match hints plus amount", () => {
    expect(
      recurringMatchesTransaction(
        sub({ name: "Jeep payment", amount: 418, account: "Manual", matchHints: ["truist"] }),
        txn({ amount: -418.5, category: "TRUIST IL PYMT", account: "Checking" }),
      ),
    ).toBe(true);
  });

  it("does not match recurring subscriptions by hint when the amount is outside tolerance", () => {
    expect(
      recurringMatchesTransaction(
        sub({ name: "Jeep payment", amount: 418, matchHints: ["truist"] }),
        txn({ amount: -500, category: "TRUIST IL PYMT" }),
      ),
    ).toBe(false);
  });

  it("keeps existing recurring match behavior when match hints are undefined", () => {
    expect(
      recurringMatchesTransaction(
        sub({ name: "Gym", amount: 20, account: "Checking" }),
        txn({ amount: -20, category: "Unknown charge", account: "checking" }),
      ),
    ).toBe(true);
    expect(
      recurringMatchesTransaction(
        sub({ name: "Gym", amount: 20 }),
        txn({ amount: -20, category: "Unknown charge", account: "checking" }),
      ),
    ).toBe(false);
  });

  it("rolls up a month while excluding transfers, deleted rows, and one-time charges", () => {
    const result = rollupMonth(
      [
        txn({ amount: 4000, categoryGroup: "income" }),
        txn({ amount: -1200, categoryGroup: "needs" }),
        txn({ amount: -100, categoryGroup: "wants", excludeFromBudget: true }),
        txn({ amount: -500, categoryGroup: "savings" }),
        txn({ amount: -300, categoryGroup: "transfer" }),
        txn({ amount: -20, categoryGroup: "wants", deletedAt: jan }),
        txn({ timestamp: feb, amount: -99, categoryGroup: "wants" }),
      ],
      "2026-01",
    );

    expect(result).toEqual({
      month: "2026-01",
      income: 4000,
      needs: 1200,
      wants: 0,
      savings: 500,
    });
  });

  it("adds active recurring commitments only when they are not already seen", () => {
    const subscriptions = [
      sub({ id: "seen", name: "Netflix", amount: 15, group: "wants" }),
      sub({ id: "unseen", name: "Car Loan", amount: 300, kind: "loan" }),
      sub({ id: "paused", name: "Paused", amount: 50, status: "canceled", group: "wants" }),
    ];
    const txns = [txn({ amount: -15, category: "Netflix", categoryGroup: "wants" })];
    const items = recurringItemsForMonth(subscriptions, txns);
    const buckets = { needs: 1000, wants: 15, savings: 200 };

    const additions = addUnseenRecurringToBuckets(buckets, subscriptions, txns);

    expect(items.wants.find((item) => item.id === "seen")?.seenThisMonth).toBe(true);
    expect(additions).toEqual({ needs: 300, wants: 0, savings: 0 });
    expect(buckets).toEqual({ needs: 1300, wants: 15, savings: 200 });
  });

  it("keeps the remaining weekly plan after only some weekly charges are seen", () => {
    const subscriptions = [
      sub({ id: "weekly", name: "Cleaner", amount: 100, cadence: "weekly", kind: "bill" }),
    ];
    const txns = [
      txn({ id: "week-1", amount: -100, category: "Cleaner" }),
      txn({ id: "week-2", amount: -100, category: "Cleaner" }),
    ];
    const items = recurringItemsForMonth(subscriptions, txns);
    const weekly = items.needs[0];
    const additions = addUnseenRecurringToBuckets(
      { needs: 200, wants: 0, savings: 0 },
      subscriptions,
      txns,
    );

    expect(weekly.expectedThisMonth).toBe(4);
    expect(weekly.matchedCount).toBe(2);
    expect(weekly.matchedAmount).toBe(200);
    expect(weekly.remainingMonthlyAmount).toBeCloseTo((100 * 52) / 12 - 200);
    expect(additions.needs).toBeCloseTo((100 * 52) / 12 - 200);
  });

  it("populates matchedTxn from the most recent matching charge and derives seenThisMonth", () => {
    const early = Date.UTC(2026, 0, 3);
    const late = Date.UTC(2026, 0, 20);
    const subscriptions = [
      sub({ id: "netflix", name: "Netflix", amount: 15, group: "wants" }),
      sub({ id: "gym", name: "Gym", amount: 40, group: "wants" }),
    ];
    const txns = [
      txn({
        id: "old",
        timestamp: early,
        amount: -15.49,
        category: "NETFLIX.COM",
        account: "Visa",
      }),
      txn({ id: "new", timestamp: late, amount: -14.99, category: "NETFLIX.COM", account: "Amex" }),
    ];

    const items = recurringItemsForMonth(subscriptions, txns);
    const netflix = items.wants.find((item) => item.id === "netflix");
    const gym = items.wants.find((item) => item.id === "gym");

    // Most recent of the two Netflix matches wins (raw signed amount + account).
    expect(netflix?.seenThisMonth).toBe(true);
    expect(netflix?.matchedTxn).toEqual({ timestamp: late, amount: -14.99, account: "Amex" });
    // Unmatched item carries no matchedTxn and is not seen.
    expect(gym?.seenThisMonth).toBe(false);
    expect(gym?.matchedTxn).toBeUndefined();
  });

  it("filters transactions by stable UTC month key", () => {
    expect(
      transactionsForMonth([txn({ timestamp: jan }), txn({ timestamp: feb })], "2026-01"),
    ).toHaveLength(1);
  });

  it("builds a monthly cash-flow projection with unseen recurring commitments", () => {
    const projection = buildCashFlowProjection({
      startMonth: "2026-01",
      months: 2,
      startingCash: 1000,
      monthlyIncome: 5000,
      monthlyBuckets: { needs: 2000, wants: 900, savings: 500 },
      subscriptions: [
        sub({ id: "loan", name: "Car Loan", amount: 450, kind: "loan" }),
        sub({ id: "streaming", name: "Netflix", amount: 20, group: "wants" }),
      ],
    });

    expect(projection.months.map((m) => m.month)).toEqual(["2026-01", "2026-02"]);
    expect(projection.months[0]).toMatchObject({
      income: 5000,
      needs: 2000,
      wants: 900,
      savings: 500,
      recurringNeeds: 450,
      recurringWants: 20,
      totalOutflow: 3870,
      netCashFlow: 1130,
      startingCash: 1000,
      endingCash: 2130,
    });
    expect(projection.endingCash).toBe(3260);
    expect(projection.totalNetCashFlow).toBe(2260);
  });

  it("does not double-count recurring commitments already seen in projected transactions", () => {
    const projection = buildCashFlowProjection({
      startMonth: "2026-01",
      months: 1,
      monthlyIncome: 5000,
      monthlyBuckets: { needs: 2000, wants: 900, savings: 500 },
      transactions: [txn({ amount: -20, category: "Netflix", categoryGroup: "wants" })],
      subscriptions: [sub({ id: "streaming", name: "Netflix", amount: 20, group: "wants" })],
    });

    expect(projection.months[0].recurringWants).toBe(0);
    expect(projection.months[0].totalOutflow).toBe(3400);
  });

  it("simulates debt payoff using the highest APR first by default", () => {
    const result = simulateDebtPayoff({
      debts: [
        { id: "car", name: "Car Loan", balance: 1000, apr: 8, minimumPayment: 100 },
        { id: "card", name: "Credit Card", balance: 500, apr: 24, minimumPayment: 50 },
      ],
      extraMonthlyPayment: 300,
    });

    expect(result.feasible).toBe(true);
    expect(result.months).toBe(4);
    expect(result.payoffOrder[0]).toBe("card");
    expect(result.totalInterest).toBeGreaterThan(0);
    expect(result.debts.find((d) => d.id === "car")?.monthsToPayoff).toBe(4);
  });

  it("marks debt payoff infeasible when payments do not cover interest", () => {
    const result = simulateDebtPayoff({
      debts: [{ id: "bad", name: "Bad Debt", balance: 1000, apr: 120, minimumPayment: 5 }],
      maxMonths: 12,
    });

    expect(result.feasible).toBe(false);
    expect(result.months).toBeNull();
    expect(result.debts[0].monthsToPayoff).toBeNull();
  });

  it("calculates emergency fund targets, coverage, and timeline", () => {
    expect(
      calculateEmergencyFund({
        monthlyEssentialExpenses: 3000,
        currentSavings: 7500,
        monthlyContribution: 750,
      }),
    ).toEqual({
      monthlyEssentialExpenses: 3000,
      minimumTarget: 9000,
      target: 18000,
      currentSavings: 7500,
      shortfall: 10500,
      surplus: 0,
      monthsCovered: 2.5,
      monthsToTarget: 14,
      status: "not-started",
    });

    expect(
      calculateEmergencyFund({
        monthlyEssentialExpenses: 3000,
        currentSavings: 21000,
      }),
    ).toMatchObject({
      shortfall: 0,
      surplus: 3000,
      monthsToTarget: 0,
      status: "surplus",
    });
  });

  it("produces deterministic fallback advice without auth or network", () => {
    const profile: UserProfile = {
      id: "profile",
      createdAt: jan,
      displayName: "Brian",
      riskTolerance: "moderate",
      monthlySavingsGoal: 1200,
    };

    const items = fallbackFinanceAdvice({
      budget: {
        monthlyTakeHome: 5000,
        targets: { needs: 0.5, wants: 0.3, savings: 0.2 },
      },
      buckets: { month: "2026-01", income: 5000, needs: 2200, wants: 2000, savings: 400 },
      subscriptions: [sub({ amount: 20 })],
      netWorth: 25000,
      profile,
    });

    expect(items.map((item) => item.category)).toContain("budget");
    expect(items.map((item) => item.category)).toContain("subscriptions");
    expect(items.map((item) => item.category)).toContain("investing");
    expect(items.map((item) => item.category)).toContain("earn");
  });

  it("names the largest subscription as the cut candidate with annualized savings", () => {
    const items = fallbackFinanceAdvice({
      budget: { monthlyTakeHome: 5000, targets: { needs: 0.5, wants: 0.3, savings: 0.2 } },
      buckets: { month: "2026-01", income: 5000, needs: 2200, wants: 1200, savings: 1000 },
      subscriptions: [sub({ name: "Netflix", amount: 15 }), sub({ name: "Peloton", amount: 44 })],
      netWorth: 25000,
      profile: { id: "profile", createdAt: jan },
    });

    const subItem = items.find((i) => i.category === "subscriptions");
    expect(subItem?.text).toContain("Peloton");
    expect(subItem?.text).toContain("$528/yr"); // 44 * 12
    expect(subItem?.action).toBe("Cut Peloton");
  });

  it("flags the highest-APR loan as a payoff/refinance candidate", () => {
    const items = fallbackFinanceAdvice({
      budget: { monthlyTakeHome: 5000, targets: { needs: 0.5, wants: 0.3, savings: 0.2 } },
      buckets: { month: "2026-01", income: 5000, needs: 2200, wants: 1200, savings: 1000 },
      subscriptions: [],
      netWorth: 25000,
      profile: { id: "profile", createdAt: jan },
      loans: [
        sub({ name: "Mortgage", amount: 1800, kind: "loan", apr: 3.1, balance: 250000 }),
        sub({ name: "Car Loan", amount: 450, kind: "loan", apr: 9.2, balance: 18000 }),
      ],
    });

    const loanItem = items.find((i) => i.text.includes("APR"));
    expect(loanItem?.text).toContain("Car Loan");
    expect(loanItem?.text).toContain("9.2% APR");
    expect(loanItem?.action).toBe("Target Car Loan payoff");
  });

  it("observes idle cash above a 6-month emergency fund", () => {
    const items = fallbackFinanceAdvice({
      budget: { monthlyTakeHome: 5000, targets: { needs: 0.5, wants: 0.3, savings: 0.2 } },
      buckets: { month: "2026-01", income: 5000, needs: 2000, wants: 1200, savings: 1000 },
      subscriptions: [],
      netWorth: 60000,
      profile: { id: "profile", createdAt: jan },
      // Monthly needs floors at the 50% take-home target ($2,500) rather than
      // the $2,000 month-to-date spend, so 6mo fund = $15,000 and $5,000 idle.
      cashOnHand: 20000,
    });

    const cashItem = items.find((i) => i.action === "Deploy idle cash");
    expect(cashItem?.category).toBe("investing");
    expect(cashItem?.text).toContain("$20,000");
    expect(cashItem?.text).toContain("$15,000");
    expect(cashItem?.text).toContain("$5,000");
  });

  it("grounds the earn suggestion in profile skills when provided", () => {
    const items = fallbackFinanceAdvice({
      budget: { monthlyTakeHome: 5000, targets: { needs: 0.5, wants: 0.3, savings: 0.2 } },
      buckets: { month: "2026-01", income: 5000, needs: 2200, wants: 1200, savings: 400 },
      subscriptions: [],
      netWorth: 25000,
      profile: {
        id: "profile",
        createdAt: jan,
        skills: ["IT infrastructure", "automation consulting"],
      },
    });

    const earnItem = items.find((i) => i.category === "earn");
    expect(earnItem?.text).toContain("IT infrastructure");
    expect(earnItem?.action).toBe("Sell IT infrastructure");
  });
});
