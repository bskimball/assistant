/**
 * Client-safe Finance Hub payload types.
 *
 * Live under `src/lib/*` so route/UI modules never import `@/server/finance`
 * purely for types (which can pull server-only code into the browser bundle).
 */

import type {
  Budget,
  DailyFinanceSnapshot,
  FinanceAdviceItem,
  ISODate,
  Subscription,
  Transaction,
} from "@/lib/domain";
import type {
  BudgetInsight,
  CashFlowCalendar,
  RecurringInsight,
  SafeToSpendResult,
} from "@/lib/finance-math";

export type DailyFinancePayload = DailyFinanceSnapshot & { updatedAt: number };
export type BudgetPayload = Budget & { updatedAt: number };

export interface FinanceHubPayload {
  snapshot: DailyFinancePayload;
  snapshotSourceDate: ISODate;
  budget: BudgetPayload | null;
  subscriptions: Subscription[];
  transactions: Transaction[];
  /** Soft-deleted ledger rows, kept separate so totals remain unaffected. */
  deletedTransactions: Transaction[];
  recurringInsights: RecurringInsight[];
  /** Current-month 50/30/20 insight — shared by Overview and safe-to-spend. */
  budgetInsight: BudgetInsight;
  safeToSpend: SafeToSpendResult;
  cashFlowCalendar: CashFlowCalendar;
}

export interface FinanceAdvicePayload {
  items: FinanceAdviceItem[];
  generatedBy: "ai" | "fallback";
  disclaimer: string;
}
