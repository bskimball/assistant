import { describe, expect, it } from "vitest";
import type { Transaction } from "@/lib/domain";
import { restoreTransactionInLedger } from "@/server/finance-mutations-impl";

describe("restoreTransactionInLedger", () => {
  it("restores a soft-deleted transaction and clears its deletion metadata", () => {
    const deleted: Transaction = {
      id: "txn-deleted",
      createdAt: 1,
      updatedAt: 2,
      deletedAt: 3,
      deletedReason: "sync-undo",
      timestamp: 1,
      type: "withdrawal",
      amount: -64.38,
      currency: "USD",
      category: "ADT Security",
      source: "sync",
    };

    const result = restoreTransactionInLedger([deleted], deleted.id, 10);

    expect(result.restored).toBe(true);
    expect(result.transactions[0]).toMatchObject({ id: deleted.id, updatedAt: 10 });
    expect(result.transactions[0].deletedAt).toBeUndefined();
    expect(result.transactions[0].deletedReason).toBeUndefined();
  });

  it("leaves active transactions unchanged", () => {
    const active = {
      id: "txn-active",
      createdAt: 1,
      timestamp: 1,
      type: "withdrawal",
      amount: -10,
      currency: "USD",
    } satisfies Transaction;

    const result = restoreTransactionInLedger([active], active.id, 10);

    expect(result).toEqual({ transactions: [active], restored: false });
  });
});
