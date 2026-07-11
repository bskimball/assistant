import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CategoryGroup, Subscription, Transaction } from "@/lib/domain";

const mockState = vi.hoisted(() => ({
  transactions: [] as Transaction[],
  subscriptions: [] as Subscription[],
  rules: {} as Record<string, CategoryGroup>,
  cache: { entries: {}, updatedAt: Date.now() } as {
    entries: Record<string, any>;
    updatedAt: number;
  },
  apiKey: undefined as string | undefined,
  completions: [] as any[],
}));

vi.mock("@/server/domain-impl", () => ({
  loadTransactionsImpl: vi.fn(async () => ({
    transactions: mockState.transactions,
    updatedAt: Date.now(),
  })),
  loadSubscriptionsImpl: vi.fn(async () => ({
    subscriptions: mockState.subscriptions,
    updatedAt: Date.now(),
  })),
  loadCategoryRulesImpl: vi.fn(async () => ({
    rules: mockState.rules,
    updatedAt: Date.now(),
  })),
  updateTransactionsImpl: vi.fn(async (mutate: (transactions: Transaction[]) => Transaction[]) => {
    mockState.transactions = mutate(mockState.transactions);
    return { transactions: mockState.transactions, updatedAt: Date.now() };
  }),
}));

vi.mock("@/server/store", () => ({
  getDomainStore: vi.fn(async () => ({
    ref: {
      get: vi.fn(async () => mockState.cache),
      update: vi.fn(
        async (
          _ref: string,
          mutate: (current: typeof mockState.cache) => typeof mockState.cache,
        ) => {
          mockState.cache = mutate(mockState.cache);
          return mockState.cache;
        },
      ),
    },
  })),
}));

vi.mock("@/server/adapters/ai", () => ({
  getGrokApiKey: vi.fn(async () => mockState.apiKey),
  getGrokJsonModel: vi.fn(async () => "grok-test"),
  completeJSON: vi.fn(async () => mockState.completions.shift() ?? { results: [] }),
}));

import {
  applyAiDecision,
  applyDeterministicRecurringMatch,
  buildMatchPrompt,
  cachedGroupFor,
  mergeAiCacheEntry,
  pruneCache,
  resolveFromCache,
  validateAiResults,
  type AiMatchCache,
} from "@/server/finance-ai-match";

const now = Date.UTC(2026, 6, 5);

function txn(partial: Partial<Transaction> = {}): Transaction {
  return {
    id: partial.id ?? "txn",
    createdAt: partial.createdAt ?? now,
    timestamp: partial.timestamp ?? now,
    type: partial.type ?? "withdrawal",
    amount: partial.amount ?? -100,
    currency: partial.currency ?? "USD",
    category: partial.category ?? "TRUIST IL PYMT PPD ID 12345",
    categoryGroup: partial.categoryGroup ?? "wants",
    account: partial.account ?? "Checking",
    notes: partial.notes,
    recurringId: partial.recurringId,
    recurringMatchSource: partial.recurringMatchSource,
    recurringMatchConfidence: partial.recurringMatchConfidence,
    recurringSuggestedId: partial.recurringSuggestedId,
  };
}

function sub(partial: Partial<Subscription> = {}): Subscription {
  return {
    id: partial.id ?? "sub-123",
    createdAt: partial.createdAt ?? now,
    name: partial.name ?? "Jeep payment",
    amount: partial.amount ?? 100,
    cadence: partial.cadence ?? "monthly",
    status: partial.status ?? "active",
    source: partial.source ?? "manual",
    kind: partial.kind ?? "loan",
    group: partial.group,
    deletedAt: partial.deletedAt,
    account: partial.account,
  };
}

function subMap(subs: Subscription[]): Map<string, Subscription> {
  return new Map(
    subs.filter((s) => !s.deletedAt && s.status === "active").map((s) => [s.id, s] as const),
  );
}

describe("finance AI charge matching helpers", () => {
  beforeEach(() => {
    mockState.transactions = [];
    mockState.subscriptions = [];
    mockState.rules = {};
    mockState.cache = { entries: {}, updatedAt: now };
    mockState.apiKey = undefined;
    mockState.completions = [];
    vi.clearAllMocks();
  });

  it("builds the expected prompt shape", () => {
    const prompt = buildMatchPrompt([txn()], [sub()]);

    expect(prompt).toContain("RECURRING ITEMS");
    expect(prompt).toContain("CHARGES");
    expect(prompt).toContain("Match on merchant semantics, not amount coincidence");
  });

  it("applies the confidence threshold matrix for recurring matches", () => {
    const subs = subMap([sub({ id: "jeep", amount: 100 })]);
    const base = txn({ amount: -100, categoryGroup: "wants" });

    expect(
      applyAiDecision(
        base,
        { group: "needs", subId: "jeep", confidence: 0.95, source: "ai" },
        subs,
        {},
      ).transaction,
    ).toMatchObject({
      recurringId: "jeep",
      recurringMatchSource: "ai",
      categoryGroup: "needs",
    });

    expect(
      applyAiDecision(
        txn({ amount: -150 }),
        { group: "needs", subId: "jeep", confidence: 0.95, source: "ai" },
        subs,
        {},
      ).transaction,
    ).toMatchObject({ recurringSuggestedId: "jeep", recurringId: undefined });

    expect(
      applyAiDecision(
        base,
        { group: "needs", subId: "jeep", confidence: 0.6, source: "ai" },
        subs,
        {},
      ).transaction,
    ).toMatchObject({ recurringSuggestedId: "jeep", recurringId: undefined });

    expect(
      applyAiDecision(
        base,
        { group: "needs", subId: "jeep", confidence: 0.3, source: "ai" },
        subs,
        {},
      ).transaction.recurringId,
    ).toBeUndefined();

    expect(
      applyAiDecision(base, { group: "needs", subId: null, confidence: 0, source: "ai" }, subs, {})
        .transaction.recurringSuggestedId,
    ).toBeUndefined();
  });

  it("persists a unique deterministic match and corrects its budget bucket", () => {
    const transaction = txn({
      category: "TRUIST IL PYMT",
      amount: -1094.31,
      categoryGroup: "wants",
    });
    const result = applyDeterministicRecurringMatch(transaction, [
      sub({ id: "car", name: "Truist IL Pymt", amount: 1094.31, kind: "loan" }),
    ]);

    expect(result).toMatchObject({ linked: true, recategorized: true });
    expect(result?.transaction).toMatchObject({ recurringId: "car", categoryGroup: "needs" });
  });

  it("does not persist an ambiguous deterministic match", () => {
    const transaction = txn({ category: "UTILITY", amount: -100 });
    const subscriptions = [
      sub({ id: "one", name: "Utility", amount: 100, kind: "bill" }),
      sub({ id: "two", name: "Utility", amount: 100, kind: "bill" }),
    ];

    expect(applyDeterministicRecurringMatch(transaction, subscriptions)).toBeNull();
  });

  it("blocks rejected sub ids for both links and suggestions", () => {
    const result = applyAiDecision(
      txn({ amount: -100 }),
      {
        group: "needs",
        subId: "jeep",
        confidence: 0.95,
        source: "ai",
        rejectedSubIds: ["jeep"],
      },
      subMap([sub({ id: "jeep", amount: 100 })]),
      {},
    );

    expect(result.linked).toBe(false);
    expect(result.suggested).toBe(false);
    expect(result.transaction.recurringId).toBeUndefined();
    expect(result.transaction.recurringSuggestedId).toBeUndefined();
  });

  it("validates model output defensively", () => {
    const charges = [txn({ id: "a" }), txn({ id: "b" })];
    const subs = subMap([
      sub({ id: "active" }),
      sub({ id: "deleted", deletedAt: now }),
      sub({ id: "canceled", status: "canceled" }),
    ]);

    const results = validateAiResults(
      {
        results: [
          { i: 0, group: "bad", subId: "missing", confidence: 2 },
          { i: 1, group: "needs", subId: "active", confidence: 0.7 },
          { i: 2, group: "wants", subId: "active", confidence: 0.9 },
        ],
      },
      charges,
      subs,
    );

    expect(results.get("a")).toEqual({ group: undefined, subId: null, confidence: 1 });
    expect(results.get("b")).toEqual({ group: "needs", subId: "active", confidence: 0.7 });
    expect(results.size).toBe(2);
  });

  it("keeps user category rules ahead of AI group decisions", () => {
    const result = applyAiDecision(
      txn({ category: "PLANET FITNESS 123", categoryGroup: "wants" }),
      { group: "needs", subId: null, confidence: 0.9, source: "ai" },
      subMap([]),
      { "planet fitness": "wants" as CategoryGroup },
    );

    expect(result.recategorized).toBe(false);
    expect(result.transaction.categoryGroup).toBe("wants");
  });

  it("prevents transfer-group auto links except for loans", () => {
    const billResult = applyAiDecision(
      txn({ amount: -100 }),
      { group: "transfer", subId: "bill", confidence: 0.95, source: "ai" },
      subMap([sub({ id: "bill", amount: 100, kind: "bill" })]),
      {},
    );
    const loanResult = applyAiDecision(
      txn({ amount: -100 }),
      { group: "transfer", subId: "loan", confidence: 0.95, source: "ai" },
      subMap([sub({ id: "loan", amount: 100, kind: "loan" })]),
      {},
    );

    expect(billResult.transaction.recurringId).toBeUndefined();
    expect(billResult.transaction.recurringSuggestedId).toBe("bill");
    expect(loanResult.transaction.recurringId).toBe("loan");
  });

  it("never downgrades a user cache entry and prunes oldest entries", () => {
    const userEntry = {
      subId: "user-sub",
      confidence: 1,
      source: "user" as const,
      updatedAt: 10,
    };

    expect(
      mergeAiCacheEntry(userEntry, {
        group: "needs",
        subId: "ai-sub",
        confidence: 0.9,
        updatedAt: 20,
      }),
    ).toBe(userEntry);

    const cache: AiMatchCache = {
      updatedAt: 4,
      entries: {
        a: { confidence: 1, source: "ai", updatedAt: 1 },
        b: { confidence: 1, source: "ai", updatedAt: 2 },
        c: { confidence: 1, source: "ai", updatedAt: 3 },
      },
    };

    expect(Object.keys(pruneCache(cache, 2).entries).sort()).toEqual(["b", "c"]);
  });

  it("resolves a repeat merchant from cache without a model result", () => {
    const cache: AiMatchCache = {
      updatedAt: now,
      entries: {
        "truist il pymt ppd id": {
          group: "needs",
          subId: "jeep",
          confidence: 0.95,
          source: "ai",
          updatedAt: now,
        },
      },
    };

    const resolved = resolveFromCache(
      txn({ category: "TRUIST IL PYMT PPD ID 99999", amount: -100 }),
      cache,
      subMap([sub({ id: "jeep", amount: 100, kind: "loan" })]),
      {},
    );

    expect(resolved?.linked).toBe(true);
    expect(resolved?.transaction.recurringId).toBe("jeep");
    expect(cachedGroupFor("TRUIST IL PYMT PPD ID 99999", cache)).toBe("needs");
  });
});
