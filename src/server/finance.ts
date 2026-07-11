/**
 * Personal Finance Hub route-facing server functions (ADR-016, ADR-019).
 *
 * Authentication belongs here; finance behavior lives in plain implementation
 * modules so it can be reused without crossing the server-function boundary.
 */

import { createServerFn } from "@tanstack/react-start";
import type { CategoryGroup, FinanceAdviceItem, ISODate, Subscription } from "@/lib/domain";
import { todayISO } from "@/lib/domain";
import { requireAuthSession } from "@/lib/auth";
import { fetchQuotes } from "@/server/adapters/quotes";
import {
  backfillSimplefinHistoryImpl,
  connectSimplefinImpl,
  disconnectSimplefinImpl,
  getSimplefinStatusImpl,
  loanOptionsForStatus,
  runSimplefinSyncImpl,
  saveSimplefinMappingsImpl,
  undoSimplefinBackfillImpl,
  type SimplefinBackfillResult,
  type SimplefinPublicStatus,
  type SimplefinSyncResult,
} from "@/server/finance-sync";
import {
  loadSubscriptionsImpl,
  loadProductivityTasksForDayImpl,
  saveBudgetImpl,
  saveProductivityTasksForDayImpl,
  saveSubscriptionsImpl,
} from "@/server/domain-impl";
import { createProductivityTask } from "@/lib/domain";
import { generateFinanceAdviceImpl, type FinanceAdvicePayload } from "@/server/finance-advice-impl";
import {
  applyRecurringInsightImpl,
  loadFinanceHubImpl,
  loadFinanceContextImpl,
  type ApplyRecurringInsightAction,
  type FinanceContext,
  type FinanceHubPayload,
} from "@/server/finance-hub-impl";
import {
  detectSubscriptionsImpl,
  dismissOneTimeSuggestionImpl,
  importTransactionsImpl,
  linkRecurringChargeImpl,
  markRecurringPaidImpl,
  recategorizeAllTransactionsImpl,
  recategorizeTransactionImpl,
  rescanRecurringMatchesImpl,
  setTransactionExcludedImpl,
  unlinkRecurringChargeImpl,
  unmarkRecurringPaidImpl,
  type ImportResult,
  type RescanStats,
} from "@/server/finance-mutations-impl";

export type {
  ApplyRecurringInsightAction,
  FinanceAdvicePayload,
  FinanceContext,
  FinanceHubPayload,
  ImportResult,
  RescanStats,
};

export interface SimplefinStatusPayload extends SimplefinPublicStatus {
  loanOptions: ReturnType<typeof loanOptionsForStatus>;
}

async function simplefinStatusWithLoans(): Promise<SimplefinStatusPayload> {
  const [status, subscriptions] = await Promise.all([
    getSimplefinStatusImpl(),
    loadSubscriptionsImpl(),
  ]);
  return {
    ...status,
    loanOptions: loanOptionsForStatus(subscriptions.subscriptions),
  };
}

export const importTransactions = createServerFn({ method: "POST" })
  .validator((data: { csv: string; institution?: string; account?: string }) => data)
  .handler(async ({ data }): Promise<ImportResult> => {
    await requireAuthSession();
    return importTransactionsImpl(data);
  });

export const getSimplefinStatus = createServerFn({ method: "GET" })
  .validator((data: Record<string, never> | undefined) => data ?? {})
  .handler(async (): Promise<SimplefinStatusPayload> => {
    await requireAuthSession();
    return simplefinStatusWithLoans();
  });

export const connectSimplefin = createServerFn({ method: "POST" })
  .validator((data: { setupToken: string }) => data)
  .handler(async ({ data }): Promise<SimplefinStatusPayload> => {
    await requireAuthSession();
    await connectSimplefinImpl(data.setupToken);
    return simplefinStatusWithLoans();
  });

export const disconnectSimplefin = createServerFn({ method: "POST" })
  .validator((data: Record<string, never> | undefined) => data ?? {})
  .handler(async (): Promise<SimplefinStatusPayload> => {
    await requireAuthSession();
    await disconnectSimplefinImpl();
    return simplefinStatusWithLoans();
  });

export const saveSimplefinMappings = createServerFn({ method: "POST" })
  .validator(
    (data: { aliases?: Record<string, string>; loanLinks?: Record<string, string | null> }) => data,
  )
  .handler(async ({ data }): Promise<SimplefinStatusPayload> => {
    await requireAuthSession();
    await saveSimplefinMappingsImpl(data);
    return simplefinStatusWithLoans();
  });

export const syncSimplefinNow = createServerFn({ method: "POST" })
  .validator((data: { force?: boolean } | undefined) => data ?? {})
  .handler(async ({ data }): Promise<SimplefinSyncResult> => {
    await requireAuthSession();
    const result = await runSimplefinSyncImpl({
      manual: true,
      force: !!data?.force,
    });
    return {
      ...result,
      status: {
        ...result.status,
        loanOptions: loanOptionsForStatus((await loadSubscriptionsImpl()).subscriptions),
      } as SimplefinStatusPayload,
    };
  });

export const backfillSimplefinHistory = createServerFn({ method: "POST" })
  .validator((data: { accountId: string }) => data)
  .handler(
    async ({ data }): Promise<SimplefinBackfillResult & { status: SimplefinStatusPayload }> => {
      await requireAuthSession();
      return {
        ...(await backfillSimplefinHistoryImpl(data.accountId)),
        status: await simplefinStatusWithLoans(),
      };
    },
  );

export const undoSimplefinHistory = createServerFn({ method: "POST" })
  .validator((data: { accountId: string }) => data)
  .handler(
    async ({ data }): Promise<SimplefinBackfillResult & { status: SimplefinStatusPayload }> => {
      await requireAuthSession();
      return {
        ...(await undoSimplefinBackfillImpl(data.accountId)),
        status: await simplefinStatusWithLoans(),
      };
    },
  );

export interface DetectResult {
  candidates: Subscription[];
  stored: Subscription[];
}

export const detectSubscriptions = createServerFn({ method: "POST" })
  .validator((data: { lookbackDays?: number } | undefined) => data ?? {})
  .handler(async ({ data }): Promise<DetectResult> => {
    await requireAuthSession();
    return detectSubscriptionsImpl(data?.lookbackDays || 180);
  });

export const saveSubscriptions = createServerFn({ method: "POST" })
  .validator((data: { subscriptions: Subscription[] }) => data)
  .handler(async ({ data }) => {
    await requireAuthSession();
    return saveSubscriptionsImpl(data);
  });

export const saveBudget = createServerFn({ method: "POST" })
  .validator(
    (data: {
      budget: {
        monthlyTakeHome: number;
        targets: { needs: number; wants: number; savings: number };
        categoryLimits?: Record<string, number>;
      };
    }) => data,
  )
  .handler(async ({ data }) => {
    await requireAuthSession();
    return saveBudgetImpl(data);
  });

export const recategorizeTransaction = createServerFn({ method: "POST" })
  .validator((data: { id: string; group: CategoryGroup }) => data)
  .handler(async ({ data }) => {
    await requireAuthSession();
    return recategorizeTransactionImpl(data);
  });

export const setTransactionExcluded = createServerFn({ method: "POST" })
  .validator((data: { id: string; excluded: boolean }) => data)
  .handler(async ({ data }) => {
    await requireAuthSession();
    return setTransactionExcludedImpl(data);
  });

export const dismissOneTimeSuggestion = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    await requireAuthSession();
    return dismissOneTimeSuggestionImpl(data.id);
  });

export const linkRecurringCharge = createServerFn({ method: "POST" })
  .validator((data: { subId: string; txnId: string }) => data)
  .handler(async ({ data }) => {
    await requireAuthSession();
    return linkRecurringChargeImpl(data);
  });

export const unlinkRecurringCharge = createServerFn({ method: "POST" })
  .validator((data: { txnId: string }) => data)
  .handler(async ({ data }) => {
    await requireAuthSession();
    return unlinkRecurringChargeImpl(data.txnId);
  });

export const markRecurringPaid = createServerFn({ method: "POST" })
  .validator((data: { subId: string; month: string; amount?: number }) => data)
  .handler(async ({ data }) => {
    await requireAuthSession();
    return markRecurringPaidImpl(data);
  });

export const unmarkRecurringPaid = createServerFn({ method: "POST" })
  .validator((data: { subId: string; month: string }) => data)
  .handler(async ({ data }) => {
    await requireAuthSession();
    return unmarkRecurringPaidImpl(data);
  });

export const recategorizeAllTransactions = createServerFn({ method: "POST" })
  .validator((data: Record<string, never> | undefined) => data ?? {})
  .handler(async (): Promise<{ changed: number; total: number }> => {
    await requireAuthSession();
    return recategorizeAllTransactionsImpl();
  });

export const rescanRecurringMatches = createServerFn({ method: "POST" })
  .validator((data: Record<string, never> | undefined) => data ?? {})
  .handler(async (): Promise<RescanStats> => {
    await requireAuthSession();
    return rescanRecurringMatchesImpl();
  });

export interface QuotesResult {
  prices: Record<string, number>;
  asOf: number;
}

export const refreshQuotes = createServerFn({ method: "POST" })
  .validator((data: { symbols: string[] }) => data)
  .handler(async ({ data }): Promise<QuotesResult> => {
    await requireAuthSession();
    return { prices: await fetchQuotes(data?.symbols ?? []), asOf: Date.now() };
  });

export const loadFinanceHub = createServerFn({ method: "GET" })
  .validator((date: ISODate | undefined) => date)
  .handler(async ({ data }): Promise<FinanceHubPayload> => {
    await requireAuthSession();
    return loadFinanceHubImpl(data || todayISO());
  });

export const applyRecurringInsight = createServerFn({ method: "POST" })
  .validator(
    (data: {
      subscriptionId: string;
      action: ApplyRecurringInsightAction;
      amount?: number;
      lastSeen?: number;
    }) => data,
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requireAuthSession();
    return applyRecurringInsightImpl(data);
  });

/** Retained for existing server callers; plain code should import finance-hub-impl directly. */
export { loadFinanceContextImpl };

export const generateFinanceAdvice = createServerFn({ method: "POST" })
  .validator((data: { date?: ISODate } | undefined) => ({ date: data?.date }))
  .handler(async ({ data }): Promise<FinanceAdvicePayload> => {
    await requireAuthSession();
    return generateFinanceAdviceImpl(data?.date || todayISO());
  });

export const acceptFinanceActions = createServerFn({ method: "POST" })
  .validator((data: { date: ISODate; items: FinanceAdviceItem[] }) => data)
  .handler(async ({ data }) => {
    await requireAuthSession();
    const existing = await loadProductivityTasksForDayImpl(data.date);
    const tasks = data.items
      .filter((item) => item.text)
      .slice(0, 8)
      .map((item) =>
        createProductivityTask({
          text: `Finance: ${item.action || item.text}`,
          date: data.date,
          tags: ["finance", "finance-plan"],
          notes: item.text,
          source: "ai",
          priority: 2,
        }),
      );
    await saveProductivityTasksForDayImpl({
      date: data.date,
      tasks: [...(existing?.tasks || []), ...tasks],
    });
    return { tasksAdded: tasks };
  });
