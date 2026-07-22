import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Budget, Subscription, Transaction } from "@/lib/domain";
import type { CategoryRuleEntry } from "@/server/finance-data-impl";

// Shared mutable fixture the mocked data layer reads from.
const mockState = vi.hoisted(() => ({
  transactions: [] as Transaction[],
  subscriptions: [] as Subscription[],
  budget: null as Budget | null,
  rules: {} as Record<string, CategoryRuleEntry>,
}));

const updateTransactionsMock = vi.hoisted(() => vi.fn());
const saveSubscriptionsMock = vi.hoisted(() => vi.fn());

vi.mock("@/server/domain-impl", () => ({
  loadLatestDailyFinanceImpl: vi.fn(async (date: string) => ({
    snapshot: {
      id: `finance-${date}`,
      date,
      netWorth: 0,
      accounts: [],
      positions: [],
      createdAt: 0,
      updatedAt: 0,
    },
    sourceDate: date,
  })),
  loadBudgetImpl: vi.fn(async () => mockState.budget),
  loadSubscriptionsImpl: vi.fn(async () => ({
    subscriptions: mockState.subscriptions,
    updatedAt: 0,
  })),
  loadTransactionsImpl: vi.fn(async () => ({
    transactions: mockState.transactions,
    updatedAt: 0,
  })),
  loadCategoryRulesImpl: vi.fn(async () => ({ rules: mockState.rules, updatedAt: 0 })),
  // These must NOT be called on a read path — assert on them below.
  updateTransactionsImpl: updateTransactionsMock,
  saveSubscriptionsImpl: saveSubscriptionsMock,
}));

import { loadFinanceHubImpl } from "@/server/finance-hub-impl";

function txn(partial: Partial<Transaction>): Transaction {
  return {
    id: partial.id ?? "txn",
    createdAt: partial.createdAt ?? 0,
    timestamp: partial.timestamp ?? Date.UTC(2026, 0, 15),
    type: partial.type ?? (partial.amount && partial.amount > 0 ? "deposit" : "withdrawal"),
    amount: partial.amount ?? -10,
    currency: "USD",
    merchant: partial.merchant,
    category: partial.category ?? "Vendor",
    categoryGroup: partial.categoryGroup ?? "wants",
    watchlistId: partial.watchlistId,
    watchlistSource: partial.watchlistSource,
    excludeFromBudget: partial.excludeFromBudget,
    deletedAt: partial.deletedAt,
    source: partial.source,
  };
}

describe("loadFinanceHubImpl read-path invariants", () => {
  beforeEach(() => {
    updateTransactionsMock.mockReset();
    saveSubscriptionsMock.mockReset();
    mockState.subscriptions = [];
    mockState.budget = {
      id: "budget",
      createdAt: 0,
      monthlyTakeHome: 5000,
      targets: { needs: 0.5, wants: 0.3, savings: 0.2 },
    } as Budget;
    mockState.rules = {};
    mockState.transactions = [
      txn({ id: "n1", category: "Kroger", amount: -200, categoryGroup: "needs" }),
      txn({ id: "w1", category: "DoorDash", amount: -60, categoryGroup: "wants" }),
    ];
  });

  it("never writes the ledger while loading the hub payload", async () => {
    await loadFinanceHubImpl("2026-01-15");
    // The regression we're guarding against: hub reads used to CAS-write
    // transactions.json to stamp watchlist tags, which raced budget views.
    expect(updateTransactionsMock).not.toHaveBeenCalled();
  });

  it("previews watchlist labels in the payload without mutating stored rows", async () => {
    const payload = await loadFinanceHubImpl("2026-01-15");
    const doordash = payload.transactions.find((t) => t.id === "w1");
    expect(doordash?.watchlistId).toBe("dining");
    // Stored fixture stays untouched (no watchlistId persisted).
    expect(mockState.transactions.find((t) => t.id === "w1")?.watchlistId).toBeUndefined();
    expect(updateTransactionsMock).not.toHaveBeenCalled();
  });

  it("does not let watchlist tagging shift 50/30/20 buckets in safe-to-spend", async () => {
    const withRules = await loadFinanceHubImpl("2026-01-15");
    mockState.rules = {
      kroger: { watchlistId: "groceries" },
      doordash: { watchlistId: "dining" },
    };
    const tagged = await loadFinanceHubImpl("2026-01-15");
    // Watchlist labels are orthogonal: posted plan spend must be identical.
    expect(tagged.safeToSpend.postedPlanSpend).toBe(withRules.safeToSpend.postedPlanSpend);
  });
});
