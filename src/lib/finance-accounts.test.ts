import { describe, expect, it } from "vitest";
import type { AccountBalance, Transaction } from "@/lib/domain";
import {
  activeTransactions,
  cashBalance,
  cashFlowBalance,
  classifyAccount,
  isActive,
} from "@/lib/finance-accounts";

describe("classifyAccount", () => {
  it("classifies cash accounts (checking, savings, cash, bank)", () => {
    expect(classifyAccount("BofA Checking")).toBe("cash");
    expect(classifyAccount("Ally Savings")).toBe("cash");
    expect(classifyAccount("Emergency Cash")).toBe("cash");
    expect(classifyAccount("Online Bank")).toBe("cash");
  });

  it("classifies credit / liability accounts first (credit, card, platinum, loan)", () => {
    expect(classifyAccount("Capital One Platinum")).toBe("credit");
    expect(classifyAccount("Chase Freedom Credit Card")).toBe("credit");
    // Loans are liabilities; hub cash filter excluded them — classify as credit.
    expect(classifyAccount("Truist Auto Loan")).toBe("credit");
  });

  it("classifies investment accounts (brokerage, ira, 401k, robinhood, stock, crypto, bitcoin, investment)", () => {
    expect(classifyAccount("Robinhood")).toBe("investments");
    expect(classifyAccount("Fidelity Brokerage")).toBe("investments");
    expect(classifyAccount("Vanguard IRA")).toBe("investments");
    expect(classifyAccount("Acme 401k")).toBe("investments");
    expect(classifyAccount("Crypto Wallet")).toBe("investments");
    expect(classifyAccount("Bitcoin")).toBe("investments");
    expect(classifyAccount("Stock Portfolio")).toBe("investments");
    expect(classifyAccount("Investment Account")).toBe("investments");
  });

  it("returns other for unrecognized names", () => {
    expect(classifyAccount("HSA")).toBe("other");
    expect(classifyAccount("Mystery")).toBe("other");
  });

  it("does not let investment/credit keywords fall through to cash", () => {
    // "bank" is a cash keyword, but credit/card/loan win first.
    expect(classifyAccount("Bank of America Credit Card")).toBe("credit");
    // "bank" present but investment keywords win.
    expect(classifyAccount("Schwab Investment Bank")).toBe("investments");
  });
});

describe("cashBalance", () => {
  const accounts = (rows: Array<[string, number]>): AccountBalance[] =>
    rows.map(([account, amount]) => ({ account, amount, currency: "USD" }));

  it("sums only positive cash accounts", () => {
    expect(
      cashBalance(
        accounts([
          ["BofA Checking", 1000],
          ["Ally Savings", 500],
          ["Capital One Platinum", -200],
          ["Robinhood", 3000],
          ["Mystery", 50],
        ]),
      ),
    ).toBe(1500);
  });

  it("excludes zero and negative cash balances", () => {
    expect(
      cashBalance(
        accounts([
          ["Checking", 0],
          ["Savings", -10],
          ["Cash Stash", 25],
        ]),
      ),
    ).toBe(25);
  });

  it("excludes loans from cash (liability, not cash)", () => {
    // Unification: hub used to exclude loans via a negative regex; classifyAccount
    // puts loans in credit so they never contribute to cashBalance.
    expect(cashBalance(accounts([["Truist Auto Loan", 12000]]))).toBe(0);
  });
});

describe("cashFlowBalance", () => {
  const accounts = (rows: Array<[string, number]>): AccountBalance[] =>
    rows.map(([account, amount]) => ({ account, amount, currency: "USD" }));

  it("includes overdrafts so the calendar start reflects negative cash", () => {
    // Unlike cashBalance, the calendar seed keeps overdrawn cash accounts and
    // still excludes credit/investment liabilities.
    expect(
      cashFlowBalance(
        accounts([
          ["Checking", 100],
          ["Savings", -25],
          ["Capital One Credit Card", -500],
        ]),
      ),
    ).toBe(75);
  });
});

describe("isActive / activeTransactions", () => {
  const base = {
    createdAt: 1,
    updatedAt: 1,
    timestamp: 1,
    type: "other" as const,
    amount: -10,
    currency: "USD",
  };

  const open: Transaction = { ...base, id: "open" };
  const gone: Transaction = { ...base, id: "gone", deletedAt: 99 };

  it("isActive is true only when deletedAt is unset", () => {
    expect(isActive(open)).toBe(true);
    expect(isActive(gone)).toBe(false);
    expect(isActive({ deletedAt: undefined })).toBe(true);
    expect(isActive({ deletedAt: null })).toBe(true);
  });

  it("activeTransactions drops soft-deleted rows", () => {
    expect(activeTransactions([open, gone])).toEqual([open]);
  });
});
