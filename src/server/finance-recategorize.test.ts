import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transaction } from "@/lib/domain";
import type { CategoryRuleEntry } from "@/server/finance-data-impl";

const mockState = vi.hoisted(() => ({
  transactions: [] as Transaction[],
  rules: {} as Record<string, CategoryRuleEntry>,
}));

vi.mock("@/server/domain-impl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/domain-impl")>()),
  loadCategoryRulesImpl: vi.fn(async () => ({ rules: mockState.rules, updatedAt: 0 })),
  updateTransactionsImpl: vi.fn(
    async (mutate: (transactions: Transaction[]) => Transaction[]) => {
      mockState.transactions = mutate(mockState.transactions);
      return { transactions: mockState.transactions, updatedAt: 0 };
    },
  ),
}));

vi.mock("@/server/finance-ai-match", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/finance-ai-match")>()),
  loadAiMatchCache: vi.fn(async () => ({ entries: {}, updatedAt: 0 })),
}));

import { recategorizeAllTransactionsImpl } from "@/server/finance-mutations-impl";

function txn(partial: Partial<Transaction>): Transaction {
  return {
    id: partial.id ?? "txn",
    createdAt: 0,
    timestamp: Date.UTC(2026, 0, 10),
    type: partial.amount && partial.amount > 0 ? "deposit" : "withdrawal",
    amount: partial.amount ?? -10,
    currency: "USD",
    ...partial,
  };
}

// Regression guard: "Recategorize all" must be idempotent and merchant-driven.
// The needs/wants bars once shifted with no transaction edits because the
// descriptor lookup started falling back to `notes` (user prose like "Marked
// paid manually"), which the keyword categorizer happily re-bucketed.
describe("recategorizeAllTransactionsImpl", () => {
  beforeEach(() => {
    mockState.rules = {};
    mockState.transactions = [];
  });

  it("never derives the 50/30/20 group from transaction notes", async () => {
    mockState.transactions = [
      // "payment"/"autopay" in notes would hit the transfer keywords;
      // "vanguard" in notes would hit savings. Neither may move the group.
      txn({
        id: "a",
        merchant: "Comcast Xfinity",
        category: "Comcast Xfinity",
        categoryGroup: "needs",
        notes: "autopay payment for vanguard-linked account",
      }),
      txn({
        id: "b",
        merchant: "Local Bistro",
        category: "Local Bistro",
        categoryGroup: "wants",
        notes: "Marked paid manually",
      }),
    ];
    await recategorizeAllTransactionsImpl();
    expect(mockState.transactions.find((t) => t.id === "a")?.categoryGroup).toBe("needs");
    expect(mockState.transactions.find((t) => t.id === "b")?.categoryGroup).toBe("wants");
  });

  it("is idempotent: a second run changes nothing", async () => {
    mockState.transactions = [
      txn({ id: "a", category: "KROGER #123", categoryGroup: "wants" }),
      txn({ id: "b", category: "NETFLIX.COM", categoryGroup: "wants" }),
    ];
    const first = await recategorizeAllTransactionsImpl();
    const afterFirst = structuredClone(mockState.transactions);
    const second = await recategorizeAllTransactionsImpl();
    expect(second.changed).toBe(0);
    // Deep-equal ignoring updatedAt churn is unnecessary — a true no-op
    // second pass must return the identical rows.
    expect(mockState.transactions).toEqual(afterFirst);
    expect(first.total).toBe(2);
  });

  it("applies learned merchant rules but leaves watchlist orthogonal to groups", async () => {
    mockState.rules = {
      "kroger": { group: "needs", watchlistId: "groceries" },
    };
    mockState.transactions = [
      txn({ id: "a", category: "KROGER #123", categoryGroup: "wants" }),
    ];
    await recategorizeAllTransactionsImpl();
    const row = mockState.transactions[0];
    expect(row.categoryGroup).toBe("needs");
    expect(row.watchlistId).toBe("groceries");
  });

  it("does not touch soft-deleted rows", async () => {
    const dead = txn({
      id: "gone",
      category: "KROGER #123",
      categoryGroup: "wants",
      deletedAt: 5,
    });
    mockState.transactions = [dead];
    await recategorizeAllTransactionsImpl();
    expect(mockState.transactions[0]).toBe(dead);
  });
});
