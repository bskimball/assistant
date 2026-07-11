import type { CategoryGroup, Subscription, Transaction } from "@/lib/domain";
import { cleanMerchantName, newId, recurringBudgetBucket, todayISO } from "@/lib/domain";
import {
  categorize,
  dedupeKeyFor,
  detectColumns,
  findHeaderIndex,
  normalizeMerchant,
  parseCsv,
  parseDate,
  parseMoney,
  ruleGroupFor,
} from "@/server/finance-parse";
import { detectRecurringCandidates, monthKey } from "@/lib/finance-math";
import {
  cachedGroupFor,
  enrichNewTransactions,
  loadAiMatchCache,
  rememberUserRecurringLink,
  rememberUserRecurringUnlink,
  rescanUnmatchedCharges,
  type RescanStats,
} from "@/server/finance-ai-match";
import {
  appendTransactionImpl,
  loadCategoryRulesImpl,
  loadSubscriptionsImpl,
  loadTransactionsImpl,
  saveSubscriptionsImpl,
  updateCategoryRulesImpl,
  updateTransactionsImpl,
} from "@/server/domain-impl";

export interface ImportResult {
  added: number;
  skipped: number;
  invalidDates: number;
  total: number;
  sample: { description: string; amount: number; group: CategoryGroup }[];
}

/** Parse and CAS-append a statement, deduping against the ledger at write time. */
export async function importTransactionsImpl(data: {
  csv: string;
  institution?: string;
  account?: string;
}): Promise<ImportResult> {
  const { csv, account } = data;
  const rows = parseCsv(csv || "");
  if (rows.length < 2) return { added: 0, skipped: 0, invalidDates: 0, total: 0, sample: [] };

  const headerIdx = findHeaderIndex(rows);
  const columns = detectColumns(rows[headerIdx]);
  const rules = (await loadCategoryRulesImpl()).rules;
  const now = Date.now();
  let parsed: Transaction[] = [];
  let sample: ImportResult["sample"] = [];
  let skipped = 0;
  let invalidDates = 0;
  await updateTransactionsImpl((transactions) => {
    parsed = [];
    sample = [];
    skipped = 0;
    invalidDates = 0;
    const seen = new Set(
      transactions
        .filter((transaction) => !transaction.deletedAt)
        .map((transaction) => transaction.dedupeKey)
        .filter(Boolean) as string[],
    );
    for (let index = headerIdx + 1; index < rows.length; index++) {
      const row = rows[index];
      const description = (
        columns.description >= 0 ? row[columns.description] : row.join(" ")
      ).trim();
      if (!description) continue;
      const timestamp = columns.date >= 0 ? parseDate(row[columns.date]) : now;
      if (timestamp === null) {
        invalidDates++;
        continue;
      }
      let amount: number;
      if (columns.amount >= 0) amount = parseMoney(row[columns.amount]);
      else if (columns.debit >= 0 || columns.credit >= 0) {
        const debit = columns.debit >= 0 ? parseMoney(row[columns.debit]) : 0;
        const credit = columns.credit >= 0 ? parseMoney(row[columns.credit]) : 0;
        amount = Math.abs(credit) - Math.abs(debit);
      } else continue;
      if (!amount) continue;
      const acct = account?.trim() || undefined;
      const dedupeKey = dedupeKeyFor({
        timestamp,
        amount,
        description,
        account: acct,
      });
      if (seen.has(dedupeKey)) {
        skipped++;
        continue;
      }
      seen.add(dedupeKey);
      const group = categorize(description, amount, rules);
      const transaction: Transaction = {
        id: newId("txn"),
        createdAt: now,
        timestamp,
        type: amount > 0 ? "deposit" : "withdrawal",
        amount,
        currency: "USD",
        account: acct,
        category: description.slice(0, 60),
        categoryGroup: group,
        notes: undefined,
        dedupeKey,
        source: "import",
      };
      parsed.push(transaction);
      if (sample.length < 6) sample.push({ description: description.slice(0, 40), amount, group });
    }
    return parsed.length ? [...transactions, ...parsed] : transactions;
  });
  await enrichNewTransactions(parsed, { manual: true });
  return {
    added: parsed.length,
    skipped,
    invalidDates,
    total: rows.length - headerIdx - 1,
    sample,
  };
}

export async function detectSubscriptionsImpl(
  lookbackDays = 180,
): Promise<{ candidates: Subscription[]; stored: Subscription[] }> {
  const now = Date.now();
  const [{ transactions }, storedStore] = await Promise.all([
    loadTransactionsImpl(),
    loadSubscriptionsImpl(),
  ]);
  const stored = storedStore.subscriptions.filter((subscription) => !subscription.deletedAt);
  const candidates = detectRecurringCandidates({
    transactions,
    subscriptions: stored,
    now,
    lookbackDays,
  }).map((candidate) => ({ ...candidate, id: newId("sub"), createdAt: now }));
  return { candidates, stored };
}

export async function recategorizeTransactionImpl(data: {
  id: string;
  group: CategoryGroup;
}): Promise<{ ok: true }> {
  const now = Date.now();
  let learnedKey: string | null = null;
  await updateTransactionsImpl((transactions) =>
    transactions.map((transaction) => {
      if (transaction.id !== data.id) return transaction;
      learnedKey = normalizeMerchant(transaction.category || "");
      return { ...transaction, categoryGroup: data.group, updatedAt: now };
    }),
  );
  if (learnedKey) {
    const key: string = learnedKey;
    await updateCategoryRulesImpl((rules) => ({ ...rules, [key]: data.group }));
  }
  return { ok: true };
}

export async function setTransactionExcludedImpl(data: {
  id: string;
  excluded: boolean;
}): Promise<{ ok: true }> {
  const now = Date.now();
  await updateTransactionsImpl((transactions) =>
    transactions.map((transaction) =>
      transaction.id === data.id
        ? { ...transaction, excludeFromBudget: data.excluded, updatedAt: now }
        : transaction,
    ),
  );
  return { ok: true };
}

export async function dismissOneTimeSuggestionImpl(id: string): Promise<{ ok: true }> {
  const now = Date.now();
  await updateTransactionsImpl((transactions) =>
    transactions.map((transaction) =>
      transaction.id === id
        ? { ...transaction, oneTimeSuggestionDismissed: true, updatedAt: now }
        : transaction,
    ),
  );
  return { ok: true };
}

export async function linkRecurringChargeImpl(data: {
  subId: string;
  txnId: string;
}): Promise<{ ok: true }> {
  const [{ subscriptions }, { transactions }] = await Promise.all([
    loadSubscriptionsImpl(),
    loadTransactionsImpl(),
  ]);
  const subscription = subscriptions.find((item) => item.id === data.subId && !item.deletedAt);
  const transaction = transactions.find((item) => item.id === data.txnId && !item.deletedAt);
  if (!subscription || !transaction) throw new Error("Recurring item or transaction not found.");
  const raw = (transaction.category || transaction.notes || "").trim();
  const hint = cleanMerchantName(raw).toLowerCase() || raw.toLowerCase().slice(0, 24);
  if (hint) {
    const hints = Array.from(new Set([...(subscription.matchHints ?? []), hint]));
    await saveSubscriptionsImpl({
      subscriptions: subscriptions.map((item) =>
        item.id === data.subId ? { ...item, matchHints: hints, updatedAt: Date.now() } : item,
      ),
    });
  }
  await updateTransactionsImpl((existing) =>
    existing.map((item) =>
      item.id === data.txnId
        ? {
            ...item,
            recurringId: data.subId,
            recurringMatchSource: "user",
            recurringMatchConfidence: undefined,
            recurringSuggestedId: undefined,
            updatedAt: Date.now(),
          }
        : item,
    ),
  );
  await rememberUserRecurringLink(transaction, data.subId);
  return { ok: true };
}

export async function unlinkRecurringChargeImpl(txnId: string): Promise<{ ok: true }> {
  let target: Transaction | undefined;
  let rejectedSubId: string | undefined;
  await updateTransactionsImpl((transactions) =>
    transactions.map((transaction) => {
      if (transaction.id !== txnId) return transaction;
      target = transaction;
      rejectedSubId = transaction.recurringId;
      return {
        ...transaction,
        recurringId: undefined,
        recurringSuggestedId: undefined,
        recurringMatchSource: "user",
        recurringMatchConfidence: undefined,
        updatedAt: Date.now(),
      };
    }),
  );
  if (!target) throw new Error("Transaction not found.");
  await rememberUserRecurringUnlink(target, rejectedSubId);
  return { ok: true };
}

function markPaidTimestamp(month: string): number {
  if (month === todayISO().slice(0, 7)) return Date.now();
  const [year, monthIndex] = month.split("-").map(Number);
  return new Date(year, monthIndex - 1, 15, 12, 0, 0).getTime();
}

export async function markRecurringPaidImpl(data: {
  subId: string;
  month: string;
  amount?: number;
}): Promise<{ ok: true }> {
  const { subscriptions } = await loadSubscriptionsImpl();
  const subscription = subscriptions.find((item) => item.id === data.subId && !item.deletedAt);
  if (!subscription) throw new Error("Recurring item not found.");
  const amount = data.amount && data.amount > 0 ? data.amount : subscription.amount;
  await appendTransactionImpl({
    timestamp: markPaidTimestamp(data.month),
    type: "withdrawal",
    amount: -Math.abs(amount),
    currency: "USD",
    account: subscription.account || "Cash / Venmo",
    category: subscription.name,
    categoryGroup: recurringBudgetBucket(subscription),
    notes: "Marked paid manually",
    source: "manual",
    recurringId: data.subId,
    recurringMatchSource: "user",
  });
  return { ok: true };
}

export async function unmarkRecurringPaidImpl(data: {
  subId: string;
  month: string;
}): Promise<{ ok: true }> {
  const now = Date.now();
  let removed = false;
  await updateTransactionsImpl((transactions) => {
    const target = transactions
      .filter(
        (transaction) =>
          !transaction.deletedAt &&
          transaction.source === "manual" &&
          transaction.recurringId === data.subId &&
          monthKey(transaction.timestamp) === data.month,
      )
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    if (!target) return transactions;
    removed = true;
    return transactions.map((transaction) =>
      transaction.id === target.id
        ? { ...transaction, deletedAt: now, updatedAt: now }
        : transaction,
    );
  });
  if (!removed) throw new Error("No manual payment to remove for that month.");
  return { ok: true };
}

export async function recategorizeAllTransactionsImpl(): Promise<{
  changed: number;
  total: number;
}> {
  const [{ rules }, aiCache] = await Promise.all([loadCategoryRulesImpl(), loadAiMatchCache()]);
  const now = Date.now();
  let changed = 0;
  let total = 0;
  await updateTransactionsImpl((transactions) => {
    changed = 0;
    total = transactions.length;
    return transactions.map((transaction) => {
      if (transaction.deletedAt) return transaction;
      const description = transaction.category || "";
      const group =
        ruleGroupFor(description, rules) ??
        cachedGroupFor(description, aiCache) ??
        categorize(description, transaction.amount, rules);
      if (group === transaction.categoryGroup) return transaction;
      changed++;
      return { ...transaction, categoryGroup: group, updatedAt: now };
    });
  });
  return { changed, total };
}

export async function rescanRecurringMatchesImpl(): Promise<RescanStats> {
  return rescanUnmatchedCharges({ manual: true });
}

export type { RescanStats };
