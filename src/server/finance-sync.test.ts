import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveAliasRenames,
  deriveSyncRenames,
  isBackfilledTransaction,
  loanOptionsForStatus,
  mergeAccountBalances,
  netWorthAfterSync,
  mergePositions,
  parseSimplefinMoney,
  positionsFromHoldings,
  renameTransactionAccounts,
  rewriteTransactionAccountLabels,
  type SimplefinState,
} from "./finance-sync";
import type { SimplefinPayload } from "@/server/adapters/simplefin";
import type { Position, Subscription, Transaction } from "@/lib/domain";
import { crossSourceTransactionMatches } from "@/lib/finance-math";

const { updateTransactionsMock } = vi.hoisted(() => ({
  updateTransactionsMock: vi.fn(),
}));

vi.mock("@/server/domain-impl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/domain-impl")>()),
  updateTransactionsImpl: updateTransactionsMock,
}));

describe("finance-sync helpers", () => {
  beforeEach(() => updateTransactionsMock.mockReset());

  it("rewrites matching frozen account labels and skips an empty rename set", async () => {
    const stored = [
      { id: "old", account: " Old Checking " },
      { id: "other", account: "Savings" },
    ] as Transaction[];
    const result = rewriteTransactionAccountLabels(stored, [
      { from: ["old checking"], to: "Household Checking" },
    ]);

    expect(result.changed).toBe(1);
    expect(result.transactions.map(({ id, account }) => ({ id, account }))).toEqual([
      { id: "old", account: "Household Checking" },
      { id: "other", account: "Savings" },
    ]);
    await expect(renameTransactionAccounts([])).resolves.toBe(0);
    expect(updateTransactionsMock).not.toHaveBeenCalled();
  });

  it("derives alias renames for setting, changing, clearing, and unchanged aliases", () => {
    const account = {
      id: "checking",
      name: "Checking (4237)",
      displayName: "M&T Bank (checking)",
      orgName: "EZChoice",
      currency: "USD",
      balance: 100,
    };
    const rawName = "EZChoice Checking (4237)";

    expect(
      deriveAliasRenames(
        { aliases: {}, loanLinks: {}, lastAccounts: [account] },
        {
          checking: "M&T Bank (checking)",
        },
      ),
    ).toEqual([
      {
        accountId: "checking",
        from: [rawName, "M&T Bank (checking)"],
        to: "M&T Bank (checking)",
      },
    ]);
    expect(
      deriveAliasRenames(
        { aliases: { checking: "Alias A" }, loanLinks: {}, lastAccounts: [account] },
        { checking: "Alias B" },
      ),
    ).toEqual([
      {
        accountId: "checking",
        from: [rawName, "Alias A", "M&T Bank (checking)"],
        to: "Alias B",
      },
    ]);
    expect(
      deriveAliasRenames(
        { aliases: { checking: "M&T Bank (checking)" }, loanLinks: {}, lastAccounts: [account] },
        { checking: "" },
      ),
    ).toEqual([
      {
        accountId: "checking",
        from: [rawName, "M&T Bank (checking)"],
        to: rawName,
      },
    ]);
    expect(
      deriveAliasRenames(
        { aliases: { checking: "M&T Bank (checking)" }, loanLinks: {}, lastAccounts: [account] },
        { checking: " M&T Bank (checking) " },
      ),
    ).toEqual([]);
  });

  it("sweeps raw account labels to the current display name on every sync", () => {
    const payload = {
      accounts: [
        {
          id: "checking",
          name: "Checking (4237)",
          org: { name: "EZChoice" },
          currency: "USD",
          balance: 100,
          transactions: [],
        },
        {
          id: "savings",
          name: "Savings (9)",
          org: { name: "M&T" },
          currency: "USD",
          balance: 5,
          transactions: [],
        },
      ],
    } as unknown as SimplefinPayload;
    const state = {
      aliases: { checking: "M&T Bank (checking)" },
      loanLinks: {},
      lastAccounts: [
        {
          id: "checking",
          name: "Checking (4237)",
          displayName: "M&T Bank (checking)",
          orgName: "EZChoice",
          currency: "USD",
          balance: 100,
        },
      ],
    } as SimplefinState;

    // The aliased account's raw label is swept to the alias even though the
    // display name did not change since the last sync (heals orphaned rows).
    // The un-aliased account maps to itself and is dropped downstream.
    expect(deriveSyncRenames(state, payload)).toEqual([
      { from: ["M&T Bank (checking)", "EZChoice Checking (4237)"], to: "M&T Bank (checking)" },
      { from: ["M&T Savings (9)"], to: "M&T Savings (9)" },
    ]);

    const stored = [
      { id: "old", account: "EZChoice Checking (4237)" },
      { id: "new", account: "M&T Bank (checking)" },
    ] as Transaction[];
    const { transactions, changed } = rewriteTransactionAccountLabels(
      stored,
      deriveSyncRenames(state, payload),
    );
    expect(changed).toBe(1);
    expect(transactions.map((t) => t.account)).toEqual([
      "M&T Bank (checking)",
      "M&T Bank (checking)",
    ]);
  });

  it("fuzzy-dedupes matching transactions from CSV and sync sources", () => {
    const existing = {
      id: "sync-adt",
      createdAt: 0,
      timestamp: Date.parse("2026-07-01T12:00:00Z"),
      type: "withdrawal",
      amount: -64.38,
      currency: "USD",
      account: "Bank of America (checking)",
      category: "CHECKCARD 0630 ADT SECURITY*XXXXX6313",
      source: "sync",
    } satisfies Transaction;

    expect(
      crossSourceTransactionMatches(
        {
          timestamp: Date.parse("2026-06-30T12:00:00Z"),
          amount: -64.38,
          account: "Bank of America",
          category: "ADT SECURITY*320556313 WWW.ADT.COM FL",
          source: "import",
        },
        existing,
      ),
    ).toBe(true);
    expect(
      crossSourceTransactionMatches(
        {
          timestamp: Date.parse("2026-06-30T12:00:00Z"),
          amount: -64.38,
          account: "Different Bank",
          category: "ADT SECURITY",
          source: "import",
        },
        existing,
      ),
    ).toBe(false);
  });

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

  it("counts manual holdings in net worth without double-counting synced holdings", () => {
    expect(
      netWorthAfterSync(
        [
          { account: "Checking", amount: 10000, currency: "USD" },
          { account: "Robinhood", amount: 5000, currency: "USD" },
        ],
        [
          {
            symbol: "MSFT",
            quantity: 10,
            price: 500,
            value: 5000,
            includedInNetWorth: false,
          },
          { symbol: "401K", quantity: 1, price: 8000, value: 8000 },
        ],
      ),
    ).toBe(23000);
  });
});
