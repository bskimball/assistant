import type { AccountBalance, Transaction } from "@/lib/domain";

export type AccountType = "cash" | "credit" | "investments" | "other";

/**
 * Classify a bank/brokerage account by keywords in its name.
 *
 * Order matters: credit/liability and investment keywords win first so names
 * like "Credit Card" or "IRA Brokerage" never fall into cash. Cash then matches
 * checking/savings/cash/bank. Everything else is "other".
 *
 * Keywords are the union of the former client `inferAccountType` and the hub's
 * inline cash filter (including "loan" as a credit/liability and "investment"
 * as investments).
 */
export function classifyAccount(name: string): AccountType {
  const s = name.toLowerCase();
  if (/(credit|card|platinum|loan)/.test(s)) return "credit";
  if (/(robinhood|stock|crypto|bitcoin|401k|brokerage|ira|investment)/.test(s))
    return "investments";
  if (/(checking|savings|cash|bank)/.test(s)) return "cash";
  return "other";
}

/** Sum of positive balances on accounts classified as cash (liquid savings). */
export function cashBalance(accounts: AccountBalance[]): number {
  return accounts
    .filter((account) => classifyAccount(account.account) === "cash" && account.amount > 0)
    .reduce((sum, account) => sum + account.amount, 0);
}

/**
 * Signed sum of all cash-classified accounts, including overdrafts (negative
 * balances). Used by the cash-flow calendar so an overdrawn checking account
 * still lowers the projected starting balance instead of silently vanishing.
 */
export function cashFlowBalance(accounts: AccountBalance[]): number {
  return accounts
    .filter((account) => classifyAccount(account.account) === "cash")
    .reduce((sum, account) => sum + account.amount, 0);
}

/** Soft-delete gate: row is active when `deletedAt` is unset. */
export function isActive<T extends { deletedAt?: unknown }>(row: T): boolean {
  return !row.deletedAt;
}

/** Active (non-deleted) ledger rows. */
export function activeTransactions(transactions: Transaction[]): Transaction[] {
  return transactions.filter(isActive);
}
