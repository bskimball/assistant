/**
 * Personal Finance Hub server module (ADR-016, ADR-019).
 *
 * Route-facing server functions for budgeting (50/30/20), subscriptions,
 * statement import, SimpleFIN bank sync, and the AI growth advisor.
 *
 * Like the coach (ADR-011), every AI path has a deterministic fallback so the
 * advisor works with no GROK_API_KEY.
 */

import { createServerFn } from "@tanstack/react-start";
import type {
  CategoryGroup,
  FinanceAdviceItem,
  ISODate,
  Subscription,
  Transaction,
  UserProfile,
} from "@/lib/domain";
import {
  createProductivityTask,
  newId,
  subscriptionMonthlyCost,
  isCuttableSubscription,
  cleanMerchantName,
  recurringKindOf,
  recurringBudgetBucket,
  todayISO,
  DEFAULT_BUDGET_TARGETS,
} from "@/lib/domain";
import { requireAuthSession } from "@/lib/auth";
import {
  categorize,
  dedupeKeyFor,
  detectColumns,
  findHeaderIndex,
  inferCadence,
  normalizeMerchant,
  parseCsv,
  parseDate,
  parseMoney,
  ruleGroupFor,
} from "@/server/finance-parse";
import {
  cachedGroupFor,
  enrichNewTransactions,
  loadAiMatchCache,
  rememberUserRecurringLink,
  rememberUserRecurringUnlink,
  rescanUnmatchedCharges,
  type RescanStats,
} from "@/server/finance-ai-match";
import { completeJSON, getGrokApiKey, getGrokJsonModel } from "@/server/adapters/ai";
import { fetchQuotes } from "@/server/adapters/quotes";
import {
  addUnseenRecurringToBuckets,
  analyzeRecurringHealth,
  fallbackFinanceAdvice,
  monthKey,
  rollupMonth,
  type RecurringInsight,
  type MonthBuckets,
} from "@/lib/finance-math";
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
  loadBudgetImpl,
  saveBudgetImpl,
  loadSubscriptionsImpl,
  saveSubscriptionsImpl,
  loadCategoryRulesImpl,
  updateCategoryRulesImpl,
  loadTransactionsImpl,
  updateTransactionsImpl,
  loadLatestDailyFinanceImpl,
  loadUserProfileImpl,
  loadProductivityTasksForDayImpl,
  saveProductivityTasksForDayImpl,
  type BudgetPayload,
  type DailyFinancePayload,
} from "@/server/domain-impl";

/* ============================================================
  IMPORT
   ============================================================ */

export interface ImportResult {
  added: number;
  skipped: number;
  /** Rows dropped because their date cell couldn't be parsed. */
  invalidDates: number;
  total: number;
  sample: { description: string; amount: number; group: CategoryGroup }[];
}

export const importTransactions = createServerFn({ method: "POST" })
  .validator((data: { csv: string; institution?: string; account?: string }) => data)
  .handler(async ({ data }): Promise<ImportResult> => {
    await requireAuthSession();
    const { csv, account } = data as { csv: string; account?: string };
    const rows = parseCsv(csv || "");
    if (rows.length < 2) return { added: 0, skipped: 0, invalidDates: 0, total: 0, sample: [] };

    const headerIdx = findHeaderIndex(rows);
    const cols = detectColumns(rows[headerIdx]);
    const rules = (await loadCategoryRulesImpl()).rules;

    const now = Date.now();
    let parsed: Transaction[] = [];
    let sample: ImportResult["sample"] = [];
    let skipped = 0;
    let invalidDates = 0;

    // CAS update: dedupe against the ledger as it is at write time, so a
    // concurrent import/edit by the other member can't be dropped or produce
    // duplicates. The mutate may re-run on conflict, so it resets its stats.
    await updateTransactionsImpl((transactions) => {
      parsed = [];
      sample = [];
      skipped = 0;
      invalidDates = 0;
      const seen = new Set(
        transactions
          .filter((t) => !t.deletedAt)
          .map((t) => t.dedupeKey)
          .filter(Boolean) as string[],
      );

      for (let i = headerIdx + 1; i < rows.length; i++) {
        const r = rows[i];
        const description = (cols.description >= 0 ? r[cols.description] : r.join(" ")).trim();
        if (!description) continue;
        const timestamp = cols.date >= 0 ? parseDate(r[cols.date]) : now;
        if (timestamp === null) {
          invalidDates++;
          continue;
        }

        let amount: number;
        if (cols.amount >= 0) {
          amount = parseMoney(r[cols.amount]);
        } else if (cols.debit >= 0 || cols.credit >= 0) {
          const debit = cols.debit >= 0 ? parseMoney(r[cols.debit]) : 0;
          const credit = cols.credit >= 0 ? parseMoney(r[cols.credit]) : 0;
          amount = Math.abs(credit) - Math.abs(debit);
        } else {
          continue;
        }
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
        const txn: Transaction = {
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
        parsed.push(txn);
        if (sample.length < 6)
          sample.push({ description: description.slice(0, 40), amount, group });
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
  });

/* ============================================================
   SIMPLEFIN CONNECTION + SYNC
   ============================================================ */

export interface SimplefinStatusPayload extends SimplefinPublicStatus {
  loanOptions: ReturnType<typeof loanOptionsForStatus>;
}

async function simplefinStatusWithLoans(): Promise<SimplefinStatusPayload> {
  const [status, subs] = await Promise.all([getSimplefinStatusImpl(), loadSubscriptionsImpl()]);
  return {
    ...status,
    loanOptions: loanOptionsForStatus(subs.subscriptions),
  };
}

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
    const result = await runSimplefinSyncImpl({ manual: true, force: !!data?.force });
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
      const result = await backfillSimplefinHistoryImpl(data.accountId);
      return { ...result, status: await simplefinStatusWithLoans() };
    },
  );

export const undoSimplefinHistory = createServerFn({ method: "POST" })
  .validator((data: { accountId: string }) => data)
  .handler(
    async ({ data }): Promise<SimplefinBackfillResult & { status: SimplefinStatusPayload }> => {
      await requireAuthSession();
      const result = await undoSimplefinBackfillImpl(data.accountId);
      return { ...result, status: await simplefinStatusWithLoans() };
    },
  );

/* ============================================================
   SUBSCRIPTION DETECTION
   Find same-merchant, similar-amount charges on a regular cadence.
   Returns candidates merged with stored subscriptions (not persisted).
   ============================================================ */

const DAY = 24 * 60 * 60 * 1000;

export interface DetectResult {
  candidates: Subscription[];
  stored: Subscription[];
}

export const detectSubscriptions = createServerFn({ method: "POST" })
  .validator((data: { lookbackDays?: number } | undefined) => data ?? {})
  .handler(async ({ data }): Promise<DetectResult> => {
    await requireAuthSession();
    const lookbackDays = (data?.lookbackDays as number) || 180;
    const cutoff = Date.now() - lookbackDays * DAY;

    const [{ transactions }, storedStore] = await Promise.all([
      loadTransactionsImpl(),
      loadSubscriptionsImpl(),
    ]);
    const stored = storedStore.subscriptions.filter((s) => !s.deletedAt);
    const storedNames = new Set(stored.map((s) => normalizeMerchant(s.name)));

    // Group recurring outflows by merchant.
    const groups = new Map<string, { ts: number; amount: number; desc: string }[]>();
    for (const t of transactions) {
      if (t.deletedAt || t.amount >= 0 || t.timestamp < cutoff) continue;
      if (t.categoryGroup === "transfer") continue;
      const key = normalizeMerchant(t.category || "");
      if (!key) continue;
      const arr = groups.get(key) ?? [];
      arr.push({
        ts: t.timestamp,
        amount: Math.abs(t.amount),
        desc: t.category || key,
      });
      groups.set(key, arr);
    }

    const now = Date.now();
    const candidates: Subscription[] = [];
    for (const [key, charges] of groups) {
      if (charges.length < 2 || storedNames.has(key)) continue;
      charges.sort((a, b) => a.ts - b.ts);
      const intervals: number[] = [];
      for (let i = 1; i < charges.length; i++) {
        intervals.push((charges[i].ts - charges[i - 1].ts) / DAY);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const cadence = inferCadence(avgInterval);
      if (!cadence) continue;

      // Amounts should be roughly stable (within 15%).
      const amounts = charges.map((c) => c.amount);
      const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      const stable = amounts.every((a) => Math.abs(a - avgAmount) <= avgAmount * 0.15);
      if (!stable) continue;

      const last = charges[charges.length - 1];
      candidates.push({
        id: newId("sub"),
        createdAt: now,
        name: cleanMerchantName(last.desc),
        amount: Math.round(avgAmount * 100) / 100,
        cadence,
        status: "active",
        source: "detected",
        lastSeen: last.ts,
      });
    }

    candidates.sort((a, b) => subscriptionMonthlyCost(b) - subscriptionMonthlyCost(a));
    return { candidates, stored };
  });

export const saveSubscriptions = createServerFn({ method: "POST" })
  .validator((data: { subscriptions: Subscription[] }) => data)
  .handler(async ({ data }) => {
    await requireAuthSession();
    return saveSubscriptionsImpl(data);
  });

/* ============================================================
   BUDGET
   ============================================================ */

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
  .handler(async ({ data }): Promise<BudgetPayload> => {
    await requireAuthSession();
    return saveBudgetImpl(data);
  });

/** Re-bucket a single transaction and remember the choice as a rule. */
export const recategorizeTransaction = createServerFn({ method: "POST" })
  .validator((data: { id: string; group: CategoryGroup }) => data)
  .handler(async ({ data }) => {
    await requireAuthSession();
    const { id, group } = data as { id: string; group: CategoryGroup };
    const now = Date.now();
    let learnedKey: string | null = null;
    await updateTransactionsImpl((transactions) =>
      transactions.map((t) => {
        if (t.id !== id) return t;
        learnedKey = normalizeMerchant(t.category || "");
        return { ...t, categoryGroup: group, updatedAt: now };
      }),
    );
    if (learnedKey) {
      const key = learnedKey;
      await updateCategoryRulesImpl((rules) => ({ ...rules, [key]: group }));
    }
    return { ok: true };
  });

/**
 * Flag (or unflag) a single transaction as a one-time charge so it drops out of
 * the recurring 50/30/20 budget comparison. Unlike recategorization, this is a
 * per-transaction decision and is NOT saved as a merchant-wide learned rule.
 */
export const setTransactionExcluded = createServerFn({ method: "POST" })
  .validator((data: { id: string; excluded: boolean }) => data)
  .handler(async ({ data }) => {
    await requireAuthSession();
    const { id, excluded } = data as { id: string; excluded: boolean };
    const now = Date.now();
    await updateTransactionsImpl((transactions) =>
      transactions.map((t) =>
        t.id === id ? { ...t, excludeFromBudget: excluded, updatedAt: now } : t,
      ),
    );
    return { ok: true };
  });

export const dismissOneTimeSuggestion = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    await requireAuthSession();
    const now = Date.now();
    await updateTransactionsImpl((transactions) =>
      transactions.map((t) =>
        t.id === data.id ? { ...t, oneTimeSuggestionDismissed: true, updatedAt: now } : t,
      ),
    );
    return { ok: true };
  });

export const linkRecurringCharge = createServerFn({ method: "POST" })
  .validator((data: { subId: string; txnId: string }) => data)
  .handler(async ({ data }) => {
    await requireAuthSession();
    const { subId, txnId } = data as { subId: string; txnId: string };
    const [{ subscriptions }, { transactions }] = await Promise.all([
      loadSubscriptionsImpl(),
      loadTransactionsImpl(),
    ]);
    const sub = subscriptions.find((s) => s.id === subId && !s.deletedAt);
    const txn = transactions.find((t) => t.id === txnId && !t.deletedAt);
    if (!sub || !txn) throw new Error("Recurring item or transaction not found.");

    const raw = (txn.category || txn.notes || "").trim();
    const hint = cleanMerchantName(raw).toLowerCase() || raw.toLowerCase().slice(0, 24);
    if (hint) {
      const nextHints = Array.from(new Set([...(sub.matchHints ?? []), hint]));
      await saveSubscriptionsImpl({
        subscriptions: subscriptions.map((s) =>
          s.id === subId ? { ...s, matchHints: nextHints, updatedAt: Date.now() } : s,
        ),
      });
    }

    await updateTransactionsImpl((existing) =>
      existing.map((t) =>
        t.id === txnId
          ? {
              ...t,
              recurringId: subId,
              recurringMatchSource: "user",
              recurringMatchConfidence: undefined,
              recurringSuggestedId: undefined,
              updatedAt: Date.now(),
            }
          : t,
      ),
    );
    await rememberUserRecurringLink(txn, subId);
    return { ok: true };
  });

export const unlinkRecurringCharge = createServerFn({ method: "POST" })
  .validator((data: { txnId: string }) => data)
  .handler(async ({ data }) => {
    await requireAuthSession();
    const { txnId } = data as { txnId: string };
    let target: Transaction | undefined;
    let rejectedSubId: string | undefined;
    await updateTransactionsImpl((transactions) =>
      transactions.map((t) => {
        if (t.id !== txnId) return t;
        target = t;
        rejectedSubId = t.recurringId;
        return {
          ...t,
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
  });

/**
 * Re-apply categorization to every stored transaction using the current
 * keyword map + learned rules. Manual recategorizations are saved as rules
 * (see above), and rules win, so this preserves user overrides while fixing
 * anything that was miscategorized by older/looser keyword logic.
 */
export const recategorizeAllTransactions = createServerFn({ method: "POST" })
  .validator((data: Record<string, never> | undefined) => data ?? {})
  .handler(async (): Promise<{ changed: number; total: number }> => {
    await requireAuthSession();
    const [{ rules }, aiCache] = await Promise.all([loadCategoryRulesImpl(), loadAiMatchCache()]);
    const now = Date.now();
    let changed = 0;
    let total = 0;
    // Mutate may re-run on CAS conflict; stats reset each attempt.
    await updateTransactionsImpl((transactions) => {
      changed = 0;
      total = transactions.length;
      return transactions.map((t) => {
        if (t.deletedAt) return t;
        const desc = t.category || "";
        const group =
          ruleGroupFor(desc, rules) ??
          cachedGroupFor(desc, aiCache) ??
          categorize(desc, t.amount, rules);
        if (group === t.categoryGroup) return t;
        changed++;
        return { ...t, categoryGroup: group, updatedAt: now };
      });
    });
    return { changed, total };
  });

export const rescanRecurringMatches = createServerFn({ method: "POST" })
  .validator((data: Record<string, never> | undefined) => data ?? {})
  .handler(async (): Promise<RescanStats> => {
    await requireAuthSession();
    return rescanUnmatchedCharges({ manual: true });
  });

/* ============================================================
   LIVE QUOTES
   Refresh holding prices from a free, no-key source. Returns only
   the symbols that resolved; unresolved ones keep their manual price
   at the call site (deterministic fallback).
   ============================================================ */

export interface QuotesResult {
  prices: Record<string, number>;
  asOf: number;
}

export const refreshQuotes = createServerFn({ method: "POST" })
  .validator((data: { symbols: string[] }) => data)
  .handler(async ({ data }): Promise<QuotesResult> => {
    await requireAuthSession();
    const symbols = (data?.symbols as string[]) ?? [];
    const prices = await fetchQuotes(symbols);
    return { prices, asOf: Date.now() };
  });

/* ============================================================
   FINANCE HUB LOADER (one round trip)
   ============================================================ */

export interface FinanceHubPayload {
  snapshot: DailyFinancePayload;
  snapshotSourceDate: ISODate;
  budget: BudgetPayload | null;
  subscriptions: Subscription[];
  transactions: Transaction[];
  recurringInsights: RecurringInsight[];
}

async function loadFinanceSnapshotForHub(
  day: ISODate,
): Promise<{ snapshot: DailyFinancePayload; sourceDate: ISODate }> {
  return loadLatestDailyFinanceImpl(day);
}

export const loadFinanceHub = createServerFn({ method: "GET" })
  .validator((date: ISODate | undefined) => date)
  .handler(async ({ data }): Promise<FinanceHubPayload> => {
    await requireAuthSession();
    const day = (data as ISODate | undefined) || todayISO();
    const [snapshotInfo, budget, subs, txns] = await Promise.all([
      loadFinanceSnapshotForHub(day),
      loadBudgetImpl(),
      loadSubscriptionsImpl(),
      loadTransactionsImpl(),
    ]);
    const subscriptions = subs.subscriptions.filter((s) => !s.deletedAt);
    const transactions = txns.transactions.filter((t) => !t.deletedAt);
    return {
      snapshot: snapshotInfo.snapshot,
      snapshotSourceDate: snapshotInfo.sourceDate,
      budget,
      subscriptions,
      transactions,
      recurringInsights: analyzeRecurringHealth({ subscriptions, transactions }),
    };
  });

export type ApplyRecurringInsightAction = "update-amount" | "cancel";

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
    const subscriptionId = data.subscriptionId?.trim();
    if (!subscriptionId) throw new Error("subscriptionId is required");

    const [subsStore, txnStore] = await Promise.all([
      loadSubscriptionsImpl(),
      loadTransactionsImpl(),
    ]);
    const subscriptions = subsStore.subscriptions.filter((s) => !s.deletedAt);
    const insight = analyzeRecurringHealth({
      subscriptions,
      transactions: txnStore.transactions.filter((t) => !t.deletedAt),
    }).find((item) => item.subscriptionId === subscriptionId);

    const next = subsStore.subscriptions.map((sub) => {
      if (sub.id !== subscriptionId) return sub;
      if (data.action === "cancel") return { ...sub, status: "canceled" as const };

      const amount = Number(data.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be positive");
      return {
        ...sub,
        amount: Math.round(amount * 100) / 100,
        lastSeen: insight?.lastChargeAt ?? data.lastSeen ?? sub.lastSeen,
      };
    });

    await saveSubscriptionsImpl({ subscriptions: next });
    return { ok: true };
  });

/* ============================================================
   FINANCE CONTEXT (for the conversational coach, ADR-018)
   A compact, robust finance snapshot that does NOT depend on a balance
   having been logged *today*: net worth comes from the most recent snapshot,
   and savings progress comes from this month's transaction rollup. This is
   what lets the coach answer "am I on track for my savings goal?".
   ============================================================ */

export interface FinanceContext {
  /** True when any finance data exists (net worth, transactions, budget, or subs). */
  hasFinance: boolean;
  netWorth: number;
  /** Date the net-worth figure is as of (may be earlier than today). */
  netWorthAsOf: ISODate;
  /** Budget take-home if set, else this month's logged income. */
  monthlyTakeHome: number;
  /** Current-month 50/30/20 actuals (needs/wants/savings/income). */
  thisMonth: MonthBuckets;
  monthlySubscriptionCost: number;
  activeSubscriptionCount: number;
}

export async function loadFinanceContextImpl(date: ISODate): Promise<FinanceContext> {
  const [snapshotInfo, budget, subs, txns] = await Promise.all([
    loadFinanceSnapshotForHub(date),
    loadBudgetImpl(),
    loadSubscriptionsImpl(),
    loadTransactionsImpl(),
  ]);
  const transactions = txns.transactions.filter((t) => !t.deletedAt);
  const month = date.slice(0, 7);
  const thisMonth = rollupMonth(transactions, month);
  const active = subs.subscriptions.filter((s) => !s.deletedAt && s.status === "active");
  const monthTxns = transactions.filter((t) => monthKey(t.timestamp) === month);
  addUnseenRecurringToBuckets(thisMonth, active, monthTxns);
  const cuttableSubscriptions = active.filter(isCuttableSubscription);
  const monthlySubscriptionCost = cuttableSubscriptions.reduce(
    (s, x) => s + subscriptionMonthlyCost(x),
    0,
  );
  const netWorth = snapshotInfo.snapshot.netWorth;

  return {
    hasFinance:
      netWorth > 0 ||
      transactions.length > 0 ||
      (budget?.monthlyTakeHome ?? 0) > 0 ||
      active.length > 0,
    netWorth,
    netWorthAsOf: snapshotInfo.sourceDate,
    monthlyTakeHome: budget?.monthlyTakeHome ?? thisMonth.income,
    thisMonth,
    monthlySubscriptionCost,
    activeSubscriptionCount: cuttableSubscriptions.length,
  };
}

/* ============================================================
   AI GROWTH ADVISOR (budget / subscriptions / investing / earn)
   Personalized + actionable, with a deterministic fallback.
   ============================================================ */

const ADVISOR_DISCLAIMER =
  "Educational guidance, not licensed financial advice. This advisor never moves money or executes trades.";

function profileSummary(p: UserProfile): string {
  const lines: string[] = [];
  if (p.displayName) lines.push(`- Name: ${p.displayName}`);
  if (p.goals?.length) lines.push(`- Goals: ${p.goals.join("; ")}`);
  if (p.skills?.length) lines.push(`- Sellable skills: ${p.skills.join("; ")}`);
  if (p.riskTolerance) lines.push(`- Risk tolerance: ${p.riskTolerance}`);
  if (p.monthlySavingsGoal) lines.push(`- Monthly savings goal: $${p.monthlySavingsGoal}`);
  if (p.financeNotes) lines.push(`- Notes: ${p.financeNotes}`);
  return lines.length ? lines.join("\n") : "- (no finance profile set)";
}

/** Does this deposit look like a regular payroll deposit (vs side income)? */
function isPaycheckLike(t: Transaction): boolean {
  const text = `${t.category || ""} ${t.notes || ""}`.toLowerCase();
  return ["payroll", "adp", "direct dep", "salary", "paycheck"].some((k) => text.includes(k));
}

const USD = (n: number) => "$" + Math.round(n).toLocaleString();

/** Previous calendar month key ("2026-07" -> "2026-06"). */
function previousMonthKey(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * Split account balances into cash-like, invested, and credit (debt) buckets by
 * name heuristics + sign, so the advisor can reason about idle cash vs an
 * emergency fund without a formal account-type field.
 */
function classifyAccountBalances(accounts: { account: string; amount: number }[]): {
  cash: number;
  invested: number;
  creditOwed: number;
} {
  let cash = 0;
  let invested = 0;
  let creditOwed = 0;
  const investedRe =
    /401|403b|ira|roth|brokerage|invest|vanguard|fidelity|schwab|etrade|robinhood|crypto|coinbase|hsa|529/i;
  const creditRe = /credit|card|visa|amex|mastercard|discover|loan|mortgage|line of credit|heloc/i;
  for (const a of accounts) {
    const name = a.account || "";
    if (a.amount < 0 || creditRe.test(name)) {
      creditOwed += Math.abs(a.amount);
    } else if (investedRe.test(name)) {
      invested += a.amount;
    } else {
      cash += a.amount;
    }
  }
  return { cash, invested, creditOwed };
}

/** Top merchants this month by total spend, with their 50/30/20 bucket. */
function topMerchantsThisMonth(
  monthTxns: Transaction[],
  limit: number,
): { name: string; total: number; bucket: string }[] {
  const map = new Map<string, { total: number; bucket: string }>();
  for (const t of monthTxns) {
    if (t.deletedAt || t.amount >= 0) continue;
    if (t.categoryGroup === "transfer" || t.categoryGroup === "income") continue;
    const name = cleanMerchantName(t.category || "") || "Unknown";
    const bucket = t.categoryGroup ?? "other";
    const cur = map.get(name) ?? { total: 0, bucket };
    cur.total += Math.abs(t.amount);
    map.set(name, cur);
  }
  return [...map.entries()]
    .map(([name, v]) => ({ name, total: v.total, bucket: v.bucket }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

export const generateFinanceAdvice = createServerFn({ method: "POST" })
  .validator((data: { date?: ISODate } | undefined) => ({ date: data?.date }))
  .handler(
    async ({
      data,
    }): Promise<{
      items: FinanceAdviceItem[];
      generatedBy: "ai" | "fallback";
      disclaimer: string;
    }> => {
      await requireAuthSession();
      const date = data?.date || todayISO();
      const [budget, subsStore, txnStore, snapshotInfo, profile] = await Promise.all([
        loadBudgetImpl(),
        loadSubscriptionsImpl(),
        loadTransactionsImpl(),
        loadFinanceSnapshotForHub(date),
        loadUserProfileImpl(),
      ]);
      const snapshot = snapshotInfo.snapshot;
      const recurring = subsStore.subscriptions.filter((s) => !s.deletedAt);
      const subscriptions = recurring.filter(
        (s) => s.status === "active" && isCuttableSubscription(s),
      );
      const activeRecurring = recurring.filter((s) => s.status === "active");
      const transactions = txnStore.transactions.filter((t) => !t.deletedAt);
      const month = date.slice(0, 7);
      const buckets = rollupMonth(transactions, month);
      // Fold in active recurring commitments not yet seen in statements so the
      // 50/30/20 buckets mirror the Budget tab.
      const monthTxns = transactions.filter((t) => monthKey(t.timestamp) === month);
      addUnseenRecurringToBuckets(buckets, activeRecurring, monthTxns);
      const netWorth = snapshot.netWorth ?? 0;

      /* ---- Income detail ---- */
      const takeHome = budget?.monthlyTakeHome ?? buckets.income;
      const targets = budget?.targets ?? DEFAULT_BUDGET_TARGETS;
      const sideIncomeMTD = monthTxns
        .filter((t) => t.amount > 0 && t.categoryGroup === "income" && !isPaycheckLike(t))
        .reduce((s, t) => s + t.amount, 0);

      /* ---- Money usage: 50/30/20 deltas, merchants, trend, one-offs ---- */
      const bucketRows = (["needs", "wants", "savings"] as const).map((b) => {
        const actual = buckets[b];
        const target = takeHome * targets[b];
        return { bucket: b, actual, target, delta: actual - target };
      });
      const topMerchants = topMerchantsThisMonth(monthTxns, 6);
      const prevMonth = previousMonthKey(month);
      const prevBuckets = rollupMonth(transactions, prevMonth);
      const oneTimeThisMonth = monthTxns
        .filter((t) => t.excludeFromBudget && t.amount < 0)
        .reduce((s, t) => s + Math.abs(t.amount), 0);

      /* ---- Recurring: loans, bills, cuttable subs, recurring savings ---- */
      const loans = activeRecurring.filter((s) => recurringKindOf(s) === "loan");
      const billsMonthly = activeRecurring
        .filter((s) => recurringKindOf(s) === "bill")
        .reduce((s, x) => s + subscriptionMonthlyCost(x), 0);
      const recurringSavingsMonthly = activeRecurring
        .filter((s) => recurringBudgetBucket(s) === "savings")
        .reduce((s, x) => s + subscriptionMonthlyCost(x), 0);
      const monthlySubTotal = subscriptions.reduce((s, x) => s + subscriptionMonthlyCost(x), 0);

      /* ---- Investments: positions + account cash split ---- */
      const positions = (snapshot.positions ?? []).filter((p) => (p.value ?? 0) > 0);
      const holdingsTotal = positions.reduce((s, p) => s + (p.value ?? 0), 0);
      const topPositions = [...positions]
        .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
        .slice(0, 8);
      const topPositionPct =
        holdingsTotal > 0 && topPositions[0] ? (topPositions[0].value / holdingsTotal) * 100 : 0;
      const { cash, invested, creditOwed } = classifyAccountBalances(snapshot.accounts ?? []);
      // buckets.needs is month-to-date; floor with the 50/30/20 needs target so
      // early-month advice doesn't overstate how many months the cash covers.
      const monthlyNeedsEstimate = Math.max(
        buckets.needs,
        takeHome > 0 ? takeHome * targets.needs : 0,
      );
      const monthsOfNeedsInCash = monthlyNeedsEstimate > 0 ? cash / monthlyNeedsEstimate : 0;

      /* ---- Targets for savings gap / revenue experiment ---- */
      const targetSavings = takeHome * targets.savings;
      const savingsGap = Math.max(0, targetSavings - buckets.savings);
      const profileGoalGap = profile.monthlySavingsGoal
        ? Math.max(0, profile.monthlySavingsGoal - buckets.savings)
        : 0;
      const revenueTarget = Math.max(
        savingsGap,
        profileGoalGap,
        takeHome > 0 ? takeHome * 0.05 : 250,
        250,
      );

      const fb = fallbackFinanceAdvice({
        budget,
        buckets,
        subscriptions,
        netWorth,
        profile,
        loans,
        cashOnHand: cash,
      });
      const apiKey = await getGrokApiKey();
      if (!apiKey)
        return {
          items: fb,
          generatedBy: "fallback",
          disclaimer: ADVISOR_DISCLAIMER,
        };

      const fmtDelta = (d: number) => (d >= 0 ? `+${USD(d)} over` : `${USD(-d)} under`);
      const loanLines = loans.length
        ? loans
            .map(
              (l) =>
                `  - ${l.name}: ${USD(subscriptionMonthlyCost(l))}/mo${
                  l.balance ? `, ${USD(l.balance)} balance` : ""
                }${l.apr ? `, ${l.apr}% APR${l.apr >= 7 ? " (HIGH — payoff/refi candidate)" : ""}` : ""}`,
            )
            .join("\n")
        : "  - (none tracked)";
      const subLines = subscriptions.length
        ? subscriptions
            .slice(0, 12)
            .map((s) => `  - ${s.name}: ${USD(subscriptionMonthlyCost(s))}/mo`)
            .join("\n")
        : "  - (none tracked)";
      const merchantLines = topMerchants.length
        ? topMerchants.map((m) => `  - ${m.name}: ${USD(m.total)} (${m.bucket})`).join("\n")
        : "  - (no spending imported this month)";
      const positionLines = topPositions.length
        ? topPositions
            .map(
              (p) =>
                `  - ${p.symbol}: ${USD(p.value)}${
                  holdingsTotal > 0 ? ` (${Math.round((p.value / holdingsTotal) * 100)}%)` : ""
                }`,
            )
            .join("\n")
        : "  - (no holdings tracked)";

      const prompt = `You are ${profile.displayName || "Brian"}'s personal financial advisor. Give specific, actionable money guidance grounded in his real numbers below. Cover budget, subscriptions, investing, and earning more. Never repeat a figure without turning it into a decision.

Profile:
${profileSummary(profile)}

INCOME (this month, ${buckets.month}):
- Take-home pay: ${takeHome ? USD(takeHome) : "unknown"}/mo
- Side income so far this month (non-payroll): ${USD(sideIncomeMTD)}

MONEY USAGE (this month vs 50/30/20 targets):
${bucketRows
  .map(
    (r) =>
      `- ${r.bucket[0].toUpperCase() + r.bucket.slice(1)}: ${USD(r.actual)} spent vs ${USD(
        r.target,
      )} target (${Math.round(targets[r.bucket] * 100)}%) — ${fmtDelta(r.delta)}`,
  )
  .join("\n")}
- Previous month (${prevMonth}) for trend: needs ${USD(prevBuckets.needs)}, wants ${USD(
        prevBuckets.wants,
      )}, savings ${USD(prevBuckets.savings)}
- One-time / excluded spend this month (ignore for recurring plan): ${USD(oneTimeThisMonth)}
- Top merchants by spend this month:
${merchantLines}

RECURRING COMMITMENTS:
- Loans (individually):
${loanLines}
- Fixed bills total: ${USD(billsMonthly)}/mo
- Cuttable subscriptions: ${subscriptions.length} totaling ${USD(monthlySubTotal)}/mo (${USD(
        monthlySubTotal * 12,
      )}/yr):
${subLines}
- Recurring savings/investing contributions: ${USD(recurringSavingsMonthly)}/mo

INVESTMENTS:
- Net worth: ${USD(netWorth)}
- Total holdings value: ${USD(holdingsTotal)}
- Top positions (symbol, value, allocation):
${positionLines}
- Concentration: largest position is ${Math.round(topPositionPct)}% of holdings${
        topPositionPct >= 25 ? " (concentrated — flag diversification)" : ""
      }
- Cash/liquidity: ${USD(cash)} cash-like${
        monthlyNeedsEstimate > 0
          ? ` (~${monthsOfNeedsInCash.toFixed(1)} months of needs spend)`
          : ""
      }, ${USD(invested)} in named investment accounts, ${USD(creditOwed)} owed on credit/debt accounts

TARGETS:
- Savings target gap: ${USD(Math.max(savingsGap, profileGoalGap))}/mo
- Revenue experiment target: ${USD(revenueTarget)}/mo

Reply with ONLY one compact JSON object (no markdown):
{ "items": [ { "category": "budget|subscriptions|investing|earn", "text": "one specific actionable sentence citing his real dollar figures and the expected monthly impact", "action": "short imperative label" } ] }

Rules:
- Return 5 to 8 items. Include at least one item in EACH category (budget, subscriptions, investing, earn) when the data supports it.
- EVERY item must cite specific dollar figures from the data above AND state the expected monthly-dollar impact of acting.
- Budget: reference the 50/30/20 deltas, named top merchants, or a high-APR loan.
- Subscriptions: name the specific subscription(s) to cut and the monthly/annual saving.
- Investing is educational only — allocation, contribution rate, concentration, idle cash vs a 3-6 month emergency fund. Never name a trade to execute. Respect his risk tolerance${
        profile.riskTolerance ? ` (${profile.riskTolerance})` : ""
      }.
- Earn: build on his actual sellable skills${
        profile.skills?.length ? ` (${profile.skills.join(", ")})` : ""
      } and his side-income history; name ONE measurable experiment with a dollar target.
- No generic advice that could apply to anyone. No disclaimers inside the items. Be concrete and encouraging.`;

      try {
        const parsed = await completeJSON<any>(apiKey, {
          model: await getGrokJsonModel(),
          messages: [
            {
              role: "system",
              content: "Return strictly valid minified JSON only. No prose.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.5,
          maxTokens: 1200,
        });
        const items: FinanceAdviceItem[] = Array.isArray(parsed.items)
          ? parsed.items
              .slice(0, 8)
              .map((s: any) => ({
                category: ["budget", "subscriptions", "investing", "earn"].includes(s.category)
                  ? s.category
                  : "budget",
                text: String(s.text || "").trim(),
                action: s.action ? String(s.action).slice(0, 40) : undefined,
              }))
              .filter((s: FinanceAdviceItem) => s.text)
          : fb;
        return {
          items: items.length ? items : fb,
          generatedBy: "ai",
          disclaimer: ADVISOR_DISCLAIMER,
        };
      } catch (e) {
        console.warn("[finance] advisor failed, using fallback", e);
        return {
          items: fb,
          generatedBy: "fallback",
          disclaimer: ADVISOR_DISCLAIMER,
        };
      }
    },
  );

/** Turn advisor recommendations into real, tracked tasks (closed loop, ADR-014). */
export const acceptFinanceActions = createServerFn({ method: "POST" })
  .validator((data: { date: ISODate; items: FinanceAdviceItem[] }) => data)
  .handler(async ({ data }) => {
    await requireAuthSession();
    const { date, items } = data as {
      date: ISODate;
      items: FinanceAdviceItem[];
    };
    const existing = await loadProductivityTasksForDayImpl(date);
    const tasks = items
      .filter((i) => i.text)
      .slice(0, 8)
      .map((i) =>
        createProductivityTask({
          text: `Finance: ${i.action || i.text}`,
          date,
          tags: ["finance", "finance-plan"],
          notes: i.text,
          source: "ai",
          priority: 2,
        }),
      );
    await saveProductivityTasksForDayImpl({
      date,
      tasks: [...(existing?.tasks || []), ...tasks],
    });
    return { tasksAdded: tasks };
  });
