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
} from "@/server/finance-parse";
import { completeJSON, getGrokApiKey } from "@/server/adapters/ai";
import { fetchQuotes } from "@/server/adapters/quotes";
import {
  addUnseenRecurringToBuckets,
  fallbackFinanceAdvice,
  monthKey,
  rollupMonth,
  type MonthBuckets,
} from "@/lib/finance-math";
import {
  connectSimplefinImpl,
  disconnectSimplefinImpl,
  getSimplefinStatusImpl,
  loanOptionsForStatus,
  runSimplefinSyncImpl,
  saveSimplefinMappingsImpl,
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
  loadDailyFinanceImpl,
  loadUserProfileImpl,
  loadProductivityTasksForDayImpl,
  saveProductivityTasksForDayImpl,
  type BudgetPayload,
  type DailyFinancePayload,
} from "@/server/domain-impl";
import { getDomainStore } from "@/server/store";
import { HOUSEHOLD_ID } from "@/lib/scope";

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
    const rules = (await loadCategoryRulesImpl()).rules;
    const now = Date.now();
    let changed = 0;
    let total = 0;
    // Mutate may re-run on CAS conflict; stats reset each attempt.
    await updateTransactionsImpl((transactions) => {
      changed = 0;
      total = transactions.length;
      return transactions.map((t) => {
        if (t.deletedAt) return t;
        const group = categorize(t.category || "", t.amount, rules);
        if (group === t.categoryGroup) return t;
        changed++;
        return { ...t, categoryGroup: group, updatedAt: now };
      });
    });
    return { changed, total };
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
}

async function loadFinanceSnapshotForHub(
  day: ISODate,
): Promise<{ snapshot: DailyFinancePayload; sourceDate: ISODate }> {
  const store = await getDomainStore({ shared: true });
  const exact = await store.daily.get<DailyFinancePayload>("daily-finance", day);
  if (exact) return { snapshot: exact, sourceDate: day };

  const { getUserPrefix, listKeys } = await import("@/server/adapters/r2");
  const prefix = `${getUserPrefix(HOUSEHOLD_ID)}/daily-finance/`;
  const dates = (await listKeys(prefix))
    .map((key) => key.match(/\/daily-finance\/(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
    .filter((date): date is ISODate => !!date && date <= day)
    .sort((a, b) => b.localeCompare(a));

  for (const sourceDate of dates) {
    const snapshot = await store.daily.get<DailyFinancePayload>("daily-finance", sourceDate);
    if (snapshot) {
      return {
        snapshot: {
          ...snapshot,
          id: `finance-${day}`,
          date: day,
        },
        sourceDate,
      };
    }
  }

  return { snapshot: await loadDailyFinanceImpl(day), sourceDate: day };
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
    return {
      snapshot: snapshotInfo.snapshot,
      snapshotSourceDate: snapshotInfo.sourceDate,
      budget,
      subscriptions: subs.subscriptions.filter((s) => !s.deletedAt),
      transactions: txns.transactions.filter((t) => !t.deletedAt),
    };
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
  if (p.riskTolerance) lines.push(`- Risk tolerance: ${p.riskTolerance}`);
  if (p.monthlySavingsGoal) lines.push(`- Monthly savings goal: $${p.monthlySavingsGoal}`);
  if (p.financeNotes) lines.push(`- Notes: ${p.financeNotes}`);
  return lines.length ? lines.join("\n") : "- (no finance profile set)";
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

      const fb = fallbackFinanceAdvice({
        budget,
        buckets,
        subscriptions,
        netWorth,
        profile,
      });
      const apiKey = await getGrokApiKey();
      if (!apiKey)
        return {
          items: fb,
          generatedBy: "fallback",
          disclaimer: ADVISOR_DISCLAIMER,
        };

      const takeHome = budget?.monthlyTakeHome ?? buckets.income;
      const targetSavings = takeHome * (budget?.targets?.savings ?? DEFAULT_BUDGET_TARGETS.savings);
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
      const monthlySubTotal = subscriptions
        .filter((s) => s.status === "active")
        .reduce((s, x) => s + subscriptionMonthlyCost(x), 0);
      const prompt = `You are ${profile.displayName || "Brian"}'s personal financial advisor. Give specific, actionable money guidance grounded in his real numbers. Cover budget, subscriptions, investing, and earning more.

Profile:
${profileSummary(profile)}

This month (${buckets.month}):
- Take-home pay: ${takeHome ? "$" + Math.round(takeHome).toLocaleString() : "unknown"}
- Needs spend: $${Math.round(buckets.needs).toLocaleString()}
- Wants spend: $${Math.round(buckets.wants).toLocaleString()}
- Savings/investing: $${Math.round(buckets.savings).toLocaleString()}
- Savings target gap: $${Math.round(Math.max(savingsGap, profileGoalGap)).toLocaleString()}
- Net worth: $${netWorth.toLocaleString()}
- Active cuttable subscriptions: ${subscriptions.filter((s) => s.status === "active").length} (~$${Math.round(monthlySubTotal).toLocaleString()}/mo)
- Revenue experiment target: $${Math.round(revenueTarget).toLocaleString()}/mo

Reply with ONLY one compact JSON object (no markdown):
{ "items": [ { "category": "budget|subscriptions|investing|earn", "text": "one specific actionable sentence referencing his numbers", "action": "short imperative label" } ] }

Rules:
- 4 to 6 items, covering each category at least once where data allows.
- Reference his actual dollar figures and the 50/30/20 framework.
- Investing guidance is educational (allocation/contribution), never specific trade execution; respect his risk tolerance.
- Earn-more guidance must name one measurable revenue experiment with a dollar target, not a vague side-hustle idea.
- Be concrete and encouraging. No disclaimers in the items.`;

      try {
        const parsed = await completeJSON<any>(apiKey, {
          model: "grok-3-mini",
          messages: [
            {
              role: "system",
              content: "Return strictly valid minified JSON only. No prose.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.5,
          maxTokens: 700,
        });
        const items: FinanceAdviceItem[] = Array.isArray(parsed.items)
          ? parsed.items
              .slice(0, 6)
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
      .slice(0, 6)
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
