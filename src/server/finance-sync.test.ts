import { describe, expect, it } from "vitest";
import {
  isBackfilledTransaction,
  loanOptionsForStatus,
  mergeAccountBalances,
  mergePositions,
  parseSimplefinMoney,
  positionsFromHoldings,
} from "./finance-sync";
import type { SimplefinPayload } from "@/server/adapters/simplefin";
import type { Position, Subscription, Transaction } from "@/lib/domain";

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

describe("backfill undo", () => {
  const txn = (over: Partial<Transaction>): Transaction => ({
    id: "t1",
    createdAt: 0,
    timestamp: Date.parse("2026-06-01T12:00:00Z"),
    type: "withdrawal",
    amount: -10,
    currency: "USD",
    source: "sync",
    dedupeKey: "sfin:acct-1:TXN-1",
    ...over,
  });

  it("matches only synced pre-cutover rows for the account", () => {
    const cutover = "2026-07-03" as const;
    expect(isBackfilledTransaction(txn({}), "acct-1", cutover)).toBe(true);
    expect(isBackfilledTransaction(txn({}), "acct-2", cutover)).toBe(false);
    expect(isBackfilledTransaction(txn({ source: "import" }), "acct-1", cutover)).toBe(false);
    expect(
      isBackfilledTransaction(
        txn({ timestamp: Date.parse("2026-07-04T12:00:00Z") }),
        "acct-1",
        cutover,
      ),
    ).toBe(false);
  });
});

describe("holdings → positions", () => {
  const account = (id: string, holdings: any[]): SimplefinPayload["accounts"][number] => ({
    id,
    name: id,
    currency: "USD",
    balance: "0",
    "balance-date": 0,
    holdings,
  });

  it("maps holdings to positions, aggregating duplicate symbols across accounts", () => {
    const payload: SimplefinPayload = {
      accounts: [
        account("a", [
          { id: "h1", market_value: "269.6822201", shares: "0.692114", symbol: "MSFT" },
          { id: "h2", market_value: "100.00", shares: "2", symbol: "spcx" },
        ]),
        account("b", [{ id: "h3", market_value: "50.00", shares: "1", symbol: "SPCX" }]),
      ],
    };
    const positions = positionsFromHoldings(payload);
    expect(positions).toEqual([
      { symbol: "MSFT", quantity: 0.692114, value: 269.68, price: 389.65 },
      { symbol: "SPCX", quantity: 3, value: 150, price: 50 },
    ]);
  });

  it("skips holdings without a symbol, positive shares, and positive value", () => {
    const payload: SimplefinPayload = {
      accounts: [
        account("a", [
          { id: "h1", market_value: "100", shares: "1" },
          { id: "h2", market_value: "0.00", shares: "1", symbol: "ZERO" },
          { id: "h3", market_value: "100", shares: "not a number", symbol: "NAN" },
        ]),
      ],
    };
    expect(positionsFromHoldings(payload)).toEqual([]);
  });

  it("drops renamed synced accounts but keeps manual and omitted-account balances", () => {
    const synced = [{ account: "M&T Bank (checking)", amount: 100, currency: "USD" }];
    const existing = [
      { account: "EZChoice Checking (4237) (4237)", amount: 100, currency: "USD" }, // old alias → dropped
      { account: "M&T Bank (checking)", amount: 90, currency: "USD" }, // replaced by synced
      { account: "ADP 401k", amount: 500, currency: "USD" }, // manual → kept
      { account: "Truist (car loan)", amount: -200, currency: "USD" }, // omitted this sync → kept
    ];
    expect(mergeAccountBalances(synced, existing, ["EZChoice Checking (4237) (4237)"])).toEqual([
      { account: "M&T Bank (checking)", amount: 100, currency: "USD" },
      { account: "ADP 401k", amount: 500, currency: "USD" },
      { account: "Truist (car loan)", amount: -200, currency: "USD" },
    ]);
  });

  it("merges synced over manual per symbol and drops sold synced symbols", () => {
    const synced: Position[] = [{ symbol: "MSFT", quantity: 1, price: 400, value: 400 }];
    const existing: Position[] = [
      { symbol: "MSFT", quantity: 2, price: 100, value: 200 }, // manual duplicate → replaced
      { symbol: "TSLA", quantity: 1, price: 200, value: 200 }, // synced last time, now sold → dropped
      { symbol: "401K", quantity: 1, price: 5000, value: 5000 }, // manual-only → kept
    ];
    expect(mergePositions(synced, existing, ["MSFT", "TSLA"])).toEqual([
      { symbol: "MSFT", quantity: 1, price: 400, value: 400 },
      { symbol: "401K", quantity: 1, price: 5000, value: 5000 },
    ]);
  });
});
