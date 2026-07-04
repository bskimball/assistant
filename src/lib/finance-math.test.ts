import { describe, expect, it } from "vitest";
import type { Subscription, Transaction, UserProfile } from "@/lib/domain";
import {
  addUnseenRecurringToBuckets,
  fallbackFinanceAdvice,
  recurringItemsForMonth,
  recurringMatchesTransaction,
  rollupMonth,
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

  it("filters transactions by stable UTC month key", () => {
    expect(
      transactionsForMonth([txn({ timestamp: jan }), txn({ timestamp: feb })], "2026-01"),
    ).toHaveLength(1);
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
});
