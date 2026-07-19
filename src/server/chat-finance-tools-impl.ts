import type { Subscription, Transaction } from "@/lib/domain";
import { cleanMerchantName, toISODate } from "@/lib/domain";
import { explainRecurringHealth, type RecurringHealthTrace } from "@/lib/finance-math";
import { loadSubscriptionsImpl, loadTransactionsImpl } from "@/server/domain-impl";

export interface ChatFinanceToolData {
  subscriptions: Subscription[];
  transactions: Transaction[];
}

export type FinanceReadToolName = "find_transactions" | "inspect_recurring" | "explain_bill_health";

export function isFinanceReadToolName(value: unknown): value is FinanceReadToolName {
  return (
    value === "find_transactions" ||
    value === "inspect_recurring" ||
    value === "explain_bill_health"
  );
}

/** Load the shared household finance records once, before the streaming Response begins. */
export async function loadChatFinanceToolData(): Promise<ChatFinanceToolData> {
  const [{ subscriptions }, { transactions }] = await Promise.all([
    loadSubscriptionsImpl(),
    loadTransactionsImpl(),
  ]);
  return { subscriptions, transactions };
}

function tokens(value: string): string[] {
  return cleanMerchantName(value)
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

/** Resolve a member-supplied bill name against live recurring items. */
export function resolveRecurringByName(
  subscriptions: Subscription[],
  name: string,
): Subscription | null {
  const query = tokens(name);
  if (query.length === 0) return null;
  const candidates = subscriptions
    .filter((subscription) => !subscription.deletedAt)
    .map((subscription) => {
      const candidate = tokens(subscription.name);
      const overlap = query.filter((token) => candidate.includes(token)).length;
      const exact =
        cleanMerchantName(subscription.name).toLowerCase() ===
        cleanMerchantName(name).toLowerCase();
      return {
        subscription,
        score: exact ? 1000 : overlap * 10 - Math.abs(candidate.length - query.length),
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.subscription.name.localeCompare(b.subscription.name));
  return candidates[0]?.subscription ?? null;
}

function descriptor(transaction: Transaction): string {
  return transaction.category || transaction.notes || "Transaction";
}

function compactTransaction(transaction: Transaction) {
  return {
    date: toISODate(transaction.timestamp),
    amount: transaction.amount,
    descriptor: descriptor(transaction),
    account: transaction.account,
    source: transaction.source,
    deleted: !!transaction.deletedAt,
    deletedReason: transaction.deletedReason,
    id: transaction.id,
  };
}

function compactTrace(trace: RecurringHealthTrace) {
  return {
    subscriptionId: trace.subscriptionId,
    window: {
      start: toISODate(trace.window.start),
      end: toISODate(trace.window.end),
      lookbackDays: trace.window.lookbackDays,
    },
    matches: trace.matchedCharges.map((match) => ({
      transactionId: match.transactionId,
      date: toISODate(match.timestamp),
      amount: match.amount,
      account: match.account,
      source: match.source,
    })),
    nearMisses: trace.nearMissCandidates.map((candidate) => ({
      transactionId: candidate.transactionId,
      date: toISODate(candidate.timestamp),
      amount: candidate.amount,
      account: candidate.account,
      source: candidate.source,
      reason: candidate.reason,
      deletedReason: candidate.deletedReason,
      amountDelta: candidate.amountDelta,
    })),
  };
}

function recurringConfig(subscription: Subscription) {
  return {
    id: subscription.id,
    name: subscription.name,
    amount: subscription.amount,
    cadence: subscription.cadence,
    status: subscription.status,
    lastSeen: subscription.lastSeen ? toISODate(subscription.lastSeen) : undefined,
    matchHints: subscription.matchHints ?? [],
  };
}

export function executeFinanceReadTool(
  name: FinanceReadToolName,
  args: Record<string, unknown>,
  data: ChatFinanceToolData,
): Record<string, unknown> {
  if (name === "find_transactions") {
    const query = String(args.query ?? "")
      .trim()
      .toLowerCase();
    const account = String(args.account ?? "")
      .trim()
      .toLowerCase();
    const startDate = typeof args.startDate === "string" ? args.startDate : undefined;
    const endDate = typeof args.endDate === "string" ? args.endDate : undefined;
    const minAmount = Number(args.minAmount);
    const maxAmount = Number(args.maxAmount);
    const includeDeleted = args.includeDeleted === true;
    const transactions = data.transactions
      .filter((transaction) => includeDeleted || !transaction.deletedAt)
      .filter((transaction) => {
        const date = toISODate(transaction.timestamp);
        const haystack = `${descriptor(transaction)} ${transaction.account ?? ""}`.toLowerCase();
        const amount = Math.abs(transaction.amount);
        return (
          (!query || haystack.includes(query)) &&
          (!account || (transaction.account ?? "").toLowerCase().includes(account)) &&
          (!startDate || date >= startDate) &&
          (!endDate || date <= endDate) &&
          (!Number.isFinite(minAmount) || amount >= minAmount) &&
          (!Number.isFinite(maxAmount) || amount <= maxAmount)
        );
      })
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 30)
      .map(compactTransaction);
    return { count: transactions.length, transactions };
  }

  const requestedName = String(args.name ?? "").trim();
  const subscription = resolveRecurringByName(data.subscriptions, requestedName);
  if (!subscription) return { found: false, query: requestedName };
  const trace = explainRecurringHealth({ sub: subscription, transactions: data.transactions });
  if (name === "explain_bill_health") {
    return { found: true, recurring: recurringConfig(subscription), trace: compactTrace(trace) };
  }

  const deletedMatch = trace.nearMissCandidates.find(
    (candidate) => candidate.reason === "matched-but-deleted",
  );
  return {
    found: true,
    recurring: recurringConfig(subscription),
    recentMatchedCharges: compactTrace(trace).matches.slice(0, 6),
    healthInsight: deletedMatch
      ? {
          issue: "matched-but-deleted",
          transactionId: deletedMatch.transactionId,
          message: "A matching charge was soft-deleted and can be restored with approval.",
        }
      : trace.matchedCharges.length === 0
        ? { issue: "no-recent-match", message: "No matching charge was found in the trace window." }
        : undefined,
  };
}
