import { describe, expect, it } from "vitest";
import { loanOptionsForStatus, parseSimplefinMoney } from "./finance-sync";
import type { Subscription } from "@/lib/domain";

describe("finance-sync helpers", () => {
  it("parses decimal money strings to cents precision", () => {
    expect(parseSimplefinMoney("100.239")).toBe(100.24);
    expect(parseSimplefinMoney("-42.1")).toBe(-42.1);
    expect(parseSimplefinMoney("not money")).toBe(0);
  });

  it("returns only active loan options for linking", () => {
    const now = Date.now();
    const subs: Subscription[] = [
      {
        id: "loan-1",
        createdAt: now,
        name: "Rocket Mortgage",
        amount: 1000,
        cadence: "monthly",
        status: "active",
        source: "manual",
        kind: "loan",
      },
      {
        id: "sub-1",
        createdAt: now,
        name: "Streaming",
        amount: 10,
        cadence: "monthly",
        status: "active",
        source: "manual",
        kind: "subscription",
      },
      {
        id: "loan-2",
        createdAt: now,
        deletedAt: now,
        name: "Old Loan",
        amount: 10,
        cadence: "monthly",
        status: "active",
        source: "manual",
        kind: "loan",
      },
    ];

    expect(loanOptionsForStatus(subs)).toEqual([
      { id: "loan-1", name: "Rocket Mortgage", balance: undefined, apr: undefined },
    ]);
  });
});
