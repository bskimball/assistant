/**
 * Personal Finance Hub server module (ADR-016).
 *
 * Route-facing server functions for budgeting (50/30/20), subscriptions,
 * statement import, and the AI growth advisor. Ingestion is manual + CSV
 * import only — no paid aggregator, no stored bank credentials (uploaded
 * statement text is parsed server-side; only normalized transactions persist).
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
  spendBucketOf,
  isBillSubscription,
  cleanMerchantName,
  todayISO,
  DEFAULT_BUDGET_TARGETS,
} from "@/lib/domain";
import { requireAuthSession } from "@/lib/auth";
import { completeJSON, getGrokApiKey } from "@/server/adapters/ai";
import { fetchQuotes } from "@/server/adapters/quotes";
import {
  loadBudgetImpl,
  saveBudgetImpl,
  loadSubscriptionsImpl,
  saveSubscriptionsImpl,
  loadCategoryRulesImpl,
  saveCategoryRulesImpl,
  loadTransactionsImpl,
  saveTransactionsImpl,
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
   CSV PARSING
   A small RFC-4180-ish parser (handles quoted fields, escaped
   quotes, and embedded commas/newlines). No dependency.
   ============================================================ */

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/** Column roles we try to locate from a statement's header row. */
interface ColumnMap {
  date: number;
  description: number;
  amount: number;
  /** Separate debit/credit columns (BoA / Capital One style). */
  debit: number;
  credit: number;
}

function detectColumns(header: string[]): ColumnMap {
  const norm = header.map((h) => h.trim().toLowerCase());
  const find = (...keys: string[]) => norm.findIndex((h) => keys.some((k) => h.includes(k)));
  return {
    date: find("date", "posted"),
    description: find("description", "payee", "merchant", "name", "memo"),
    amount: find("amount", "value", "amt"),
    debit: find("debit"),
    credit: find("credit"),
  };
}

/** A usable header row has a date column and at least one money column. */
function isHeaderRow(cols: ColumnMap): boolean {
  return cols.date >= 0 && (cols.amount >= 0 || cols.debit >= 0 || cols.credit >= 0);
}

/**
 * Locate the transaction header row. Bank of America (and some others)
 * prepend a balance-summary block before the real "Date,Description,Amount,…"
 * header, so we can't assume it's row 0. Scan the first chunk of rows for the
 * first one that looks like a real header; fall back to row 0.
 */
function findHeaderIndex(rows: string[][]): number {
  const limit = Math.min(rows.length, 25);
  for (let i = 0; i < limit; i++) {
    if (isHeaderRow(detectColumns(rows[i]))) return i;
  }
  return 0;
}

function parseMoney(raw: string): number {
  if (!raw) return 0;
  const neg = /^\(.*\)$/.test(raw.trim()) || raw.trim().startsWith("-");
  const n = Number(raw.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
}

function parseDate(raw: string): number {
  const t = Date.parse(raw.trim());
  if (Number.isFinite(t)) return t;
  // Fallback for MM/DD/YYYY without explicit timezone parsing oddities.
  const m = raw.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    const [, mo, d, y] = m;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    return new Date(year, Number(mo) - 1, Number(d)).getTime();
  }
  return Date.now();
}

/* ============================================================
   CATEGORIZATION (50/30/20)
   Built-in keyword map + learned overrides (category-rules.json).
   ============================================================ */

const KEYWORD_GROUPS: { group: CategoryGroup; keywords: string[] }[] = [
  {
    group: "income",
    keywords: ["payroll", "adp", "direct dep", "deposit", "salary", "paycheck", "interest paid"],
  },
  {
    group: "transfer",
    keywords: [
      "transfer",
      "zelle",
      "venmo",
      "cash app",
      "withdrawal",
      "atm",
      "online banking",
      "payment thank you",
      "autopay",
      "cc payment",
      // Credit-card / bill payoffs moved out of an account are debt movement,
      // not consumption — excluding them avoids double-counting the card's
      // purchases plus the payment. BoA writes these as "… DES:ONLINE PMT".
      "online pmt",
      "online payment",
      "bill pay",
      "billpay",
      "e-payment",
      "epay",
      "card payment",
      "cardmember serv",
      "card services",
    ],
  },
  {
    group: "savings",
    keywords: [
      "robinhood",
      "vanguard",
      "fidelity",
      "401k",
      "401(k)",
      "ira",
      "brokerage",
      "betterment",
      "wealthfront",
      "acorns",
      "savings",
    ],
  },
  {
    group: "needs",
    keywords: [
      "rent",
      "mortgage",
      "m&t",
      "electric",
      "gas company",
      "water",
      "utility",
      "internet",
      "comcast",
      "xfinity",
      "verizon",
      "at&t",
      "t-mobile",
      "insurance",
      "geico",
      "progressive",
      "pharmacy",
      "cvs",
      "walgreens",
      "doctor",
      "medical",
      "grocery",
      "groceries",
      "safeway",
      "kroger",
      "wegmans",
      "aldi",
      "costco",
      "walmart",
      "target",
      "shell",
      "exxon",
      "chevron",
      "bp",
      "fuel",
      "childcare",
      "daycare",
      "tuition",
      "student loan",
    ],
  },
  {
    group: "wants",
    keywords: [
      "netflix",
      "hulu",
      "spotify",
      "disney",
      "hbo",
      "max",
      "youtube",
      "prime video",
      "apple",
      "amazon",
      "doordash",
      "uber eats",
      "grubhub",
      "restaurant",
      "starbucks",
      "dunkin",
      "mcdonald",
      "chipotle",
      "bar ",
      "steakhouse",
      "cafe",
      "coffee",
      "steam",
      "playstation",
      "xbox",
      "nintendo",
      "gym",
      "planet fitness",
      "peloton",
      "golf",
      "hotel",
      "airbnb",
      "airline",
      "delta",
      "united",
      "ticket",
      "cinema",
      "amc",
    ],
  },
];

function normalizeMerchant(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/\b\d{2,}\b/g, "") // strip long numbers (store ids, dates)
    .replace(/[^a-z& ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function categorize(
  description: string,
  amount: number,
  rules: Record<string, CategoryGroup>,
): CategoryGroup {
  const norm = normalizeMerchant(description);
  // Learned overrides win.
  for (const [key, group] of Object.entries(rules)) {
    if (norm.includes(key)) return group;
  }
  const haystack = description.toLowerCase();
  for (const { group, keywords } of KEYWORD_GROUPS) {
    if (keywords.some((k) => haystack.includes(k))) return group;
  }
  // Unknown: positive = income, negative spend defaults to discretionary (wants)
  // so it surfaces for review rather than silently inflating "needs".
  return amount > 0 ? "income" : "wants";
}

function dedupeKeyFor(t: {
  timestamp: number;
  amount: number;
  description: string;
  account?: string;
}): string {
  const day = new Date(t.timestamp).toISOString().slice(0, 10);
  return `${day}|${t.amount.toFixed(2)}|${normalizeMerchant(t.description)}|${t.account ?? ""}`;
}

/* ============================================================
   IMPORT
   ============================================================ */

export interface ImportResult {
  added: number;
  skipped: number;
  total: number;
  sample: { description: string; amount: number; group: CategoryGroup }[];
}

export const importTransactions = createServerFn({ method: "POST" })
  .validator((data: { csv: string; institution?: string; account?: string }) => data)
  .handler(async (ctx: any): Promise<ImportResult> => {
    await requireAuthSession(ctx.request);
    const { csv, account } = ctx.data as { csv: string; account?: string };
    const rows = parseCsv(csv || "");
    if (rows.length < 2) return { added: 0, skipped: 0, total: 0, sample: [] };

    const headerIdx = findHeaderIndex(rows);
    const cols = detectColumns(rows[headerIdx]);
    const rules = (await loadCategoryRulesImpl()).rules;
    const existing = await loadTransactionsImpl();
    const seen = new Set(
      existing.transactions
        .filter((t) => !t.deletedAt)
        .map((t) => t.dedupeKey)
        .filter(Boolean) as string[],
    );

    const now = Date.now();
    const parsed: Transaction[] = [];
    const sample: ImportResult["sample"] = [];
    let skipped = 0;

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      const description = (cols.description >= 0 ? r[cols.description] : r.join(" ")).trim();
      if (!description) continue;
      const timestamp = cols.date >= 0 ? parseDate(r[cols.date]) : now;

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
      if (sample.length < 6) sample.push({ description: description.slice(0, 40), amount, group });
    }

    if (parsed.length) {
      await saveTransactionsImpl({
        transactions: [...existing.transactions, ...parsed],
      });
    }
    return {
      added: parsed.length,
      skipped,
      total: rows.length - headerIdx - 1,
      sample,
    };
  });

/* ============================================================
   SUBSCRIPTION DETECTION
   Find same-merchant, similar-amount charges on a regular cadence.
   Returns candidates merged with stored subscriptions (not persisted).
   ============================================================ */

const DAY = 24 * 60 * 60 * 1000;

function inferCadence(intervalDays: number): Subscription["cadence"] | null {
  if (intervalDays >= 5 && intervalDays <= 9) return "weekly";
  if (intervalDays >= 26 && intervalDays <= 35) return "monthly";
  if (intervalDays >= 350 && intervalDays <= 380) return "annual";
  return null;
}

export interface DetectResult {
  candidates: Subscription[];
  stored: Subscription[];
}

export const detectSubscriptions = createServerFn({ method: "POST" })
  .validator((data: { lookbackDays?: number } | undefined) => data ?? {})
  .handler(async (ctx: any): Promise<DetectResult> => {
    await requireAuthSession(ctx.request);
    const lookbackDays = (ctx.data?.lookbackDays as number) || 180;
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
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    return saveSubscriptionsImpl(ctx.data);
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
  .handler(async (ctx: any): Promise<BudgetPayload> => {
    await requireAuthSession(ctx.request);
    return saveBudgetImpl(ctx.data);
  });

/** Re-bucket a single transaction and remember the choice as a rule. */
export const recategorizeTransaction = createServerFn({ method: "POST" })
  .validator((data: { id: string; group: CategoryGroup }) => data)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { id, group } = ctx.data as { id: string; group: CategoryGroup };
    const store = await loadTransactionsImpl();
    const now = Date.now();
    let learnedKey: string | null = null;
    const transactions = store.transactions.map((t) => {
      if (t.id !== id) return t;
      learnedKey = normalizeMerchant(t.category || "");
      return { ...t, categoryGroup: group, updatedAt: now };
    });
    await saveTransactionsImpl({ transactions });
    if (learnedKey) {
      const rulesStore = await loadCategoryRulesImpl();
      await saveCategoryRulesImpl({
        rules: { ...rulesStore.rules, [learnedKey]: group },
      });
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
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { id, excluded } = ctx.data as { id: string; excluded: boolean };
    const store = await loadTransactionsImpl();
    const now = Date.now();
    const transactions = store.transactions.map((t) =>
      t.id === id ? { ...t, excludeFromBudget: excluded, updatedAt: now } : t,
    );
    await saveTransactionsImpl({ transactions });
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
  .handler(async (ctx: any): Promise<{ changed: number; total: number }> => {
    await requireAuthSession(ctx.request);
    const [{ transactions }, rulesStore] = await Promise.all([
      loadTransactionsImpl(),
      loadCategoryRulesImpl(),
    ]);
    const rules = rulesStore.rules;
    const now = Date.now();
    let changed = 0;
    const next = transactions.map((t) => {
      if (t.deletedAt) return t;
      const group = categorize(t.category || "", t.amount, rules);
      if (group === t.categoryGroup) return t;
      changed++;
      return { ...t, categoryGroup: group, updatedAt: now };
    });
    if (changed) await saveTransactionsImpl({ transactions: next });
    return { changed, total: transactions.length };
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
  .handler(async (ctx: any): Promise<QuotesResult> => {
    await requireAuthSession(ctx.request);
    const symbols = (ctx.data?.symbols as string[]) ?? [];
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
  const { ensureHouseholdFinanceMigrated } = await import("@/server/migrate");
  await ensureHouseholdFinanceMigrated();
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
  .handler(async (ctx: any): Promise<FinanceHubPayload> => {
    await requireAuthSession(ctx.request);
    const day = (ctx.data as ISODate | undefined) || todayISO();
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
   MONTH ROLLUP (50/30/20 actuals)
   ============================================================ */

export interface MonthBuckets {
  needs: number;
  wants: number;
  savings: number;
  income: number;
  month: string; // YYYY-MM
}

function monthKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

function rollupMonth(transactions: Transaction[], month: string): MonthBuckets {
  const b: MonthBuckets = { needs: 0, wants: 0, savings: 0, income: 0, month };
  for (const t of transactions) {
    if (t.deletedAt || monthKey(t.timestamp) !== month) continue;
    if (t.excludeFromBudget) continue;
    if (t.categoryGroup === "income") {
      b.income += Math.abs(t.amount);
      continue;
    }
    const bucket = spendBucketOf(t.categoryGroup);
    if (bucket) b[bucket] += Math.abs(t.amount);
  }
  return b;
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

function fallbackAdvice(args: {
  budget: BudgetPayload | null;
  buckets: MonthBuckets;
  subscriptions: Subscription[];
  netWorth: number;
  profile: UserProfile;
}): FinanceAdviceItem[] {
  const { budget, buckets, subscriptions, netWorth, profile } = args;
  const items: FinanceAdviceItem[] = [];
  const takeHome = budget?.monthlyTakeHome ?? buckets.income;
  const targets = budget?.targets ?? DEFAULT_BUDGET_TARGETS;

  // BUDGET — compare actual vs 50/30/20.
  if (takeHome > 0) {
    const checks: { bucket: "needs" | "wants" | "savings"; actual: number }[] = [
      { bucket: "needs", actual: buckets.needs },
      { bucket: "wants", actual: buckets.wants },
      { bucket: "savings", actual: buckets.savings },
    ];
    for (const { bucket, actual } of checks) {
      const targetPct = targets[bucket];
      const actualPct = actual / takeHome;
      if (bucket === "wants" && actualPct > targetPct + 0.05) {
        items.push({
          category: "budget",
          text: `Wants spending is ${Math.round(actualPct * 100)}% of take-home vs a ${Math.round(targetPct * 100)}% target — about $${Math.round((actualPct - targetPct) * takeHome).toLocaleString()} over. Trim the two largest discretionary categories.`,
          action: "Review top wants spending",
        });
      }
      if (bucket === "savings" && actualPct < targetPct - 0.03) {
        items.push({
          category: "budget",
          text: `Savings rate is ${Math.round(actualPct * 100)}% vs a ${Math.round(targetPct * 100)}% target. Automate a transfer of $${Math.round((targetPct - actualPct) * takeHome).toLocaleString()}/mo to close the gap.`,
          action: "Automate savings transfer",
        });
      }
    }
  } else {
    items.push({
      category: "budget",
      text: "Set your monthly take-home pay and import a statement to see your real 50/30/20 breakdown.",
      action: "Set take-home pay",
    });
  }

  // SUBSCRIPTIONS — audit total + stale.
  const active = subscriptions.filter((s) => s.status === "active");
  if (active.length) {
    const monthlyTotal = active.reduce((s, x) => s + subscriptionMonthlyCost(x), 0);
    const stale = active.filter((s) => s.lastSeen && Date.now() - s.lastSeen > 75 * DAY);
    items.push({
      category: "subscriptions",
      text: `You're carrying ${active.length} subscriptions totaling ~$${Math.round(monthlyTotal).toLocaleString()}/mo ($${Math.round(monthlyTotal * 12).toLocaleString()}/yr).${stale.length ? ` ${stale.length} haven't charged in 75+ days — cancel candidates.` : " Cancel any you haven't used this month."}`,
      action: "Audit subscriptions",
    });
  }

  // INVESTING — risk-appropriate, contribution-focused.
  const riskNote =
    profile.riskTolerance === "aggressive"
      ? "Given your aggressive risk tolerance, keep a high equity allocation but make sure you hold 3–6 months of expenses in cash first."
      : profile.riskTolerance === "conservative"
        ? "With a conservative profile, prioritize an emergency fund and broad low-cost index funds over individual picks."
        : "Favor broad low-cost index funds; increase 401k contribution at least to any employer match.";
  items.push({
    category: "investing",
    text: `${riskNote} Max free money first: confirm you're capturing your full ADP 401k match.`,
    action: "Check 401k match",
  });

  // EARN MORE / SIDE HUSTLE — grounded in savings gap + skills.
  const surplus = takeHome > 0 ? takeHome - buckets.needs - buckets.wants - buckets.savings : 0;
  const targetSavings = takeHome > 0 ? takeHome * targets.savings : 0;
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
  const skills = profile.goals?.length
    ? ` Leverage what you already do (${profile.goals.slice(0, 2).join(", ")}).`
    : "";
  items.push({
    category: "earn",
    text: `Run a $${Math.round(revenueTarget).toLocaleString()}/mo revenue experiment to accelerate net worth (currently $${netWorth.toLocaleString()}).${surplus > 0 ? ` You have ~$${Math.round(surplus).toLocaleString()}/mo of surplus to seed it.` : ""} Pick one measurable lane: raise/client-rate conversation, consulting audit, or productized skill offer.${skills}`,
    action: "Start revenue experiment",
  });

  return items;
}

export const generateFinanceAdvice = createServerFn({ method: "POST" })
  .validator((data: { date?: ISODate } | undefined) => data ?? {})
  .handler(
    async (
      ctx: any,
    ): Promise<{
      items: FinanceAdviceItem[];
      generatedBy: "ai" | "fallback";
      disclaimer: string;
    }> => {
      await requireAuthSession(ctx.request);
      const date = (ctx.data?.date as ISODate) || todayISO();
      const [budget, subsStore, txnStore, snapshotInfo, profile] = await Promise.all([
        loadBudgetImpl(),
        loadSubscriptionsImpl(),
        loadTransactionsImpl(),
        loadFinanceSnapshotForHub(date),
        loadUserProfileImpl(),
      ]);
      const snapshot = snapshotInfo.snapshot;
      const recurring = subsStore.subscriptions.filter((s) => !s.deletedAt);
      // Fixed bills (mortgage, car, …) are Needs, not discretionary subs.
      const subscriptions = recurring.filter((s) => !isBillSubscription(s));
      const bills = recurring.filter((s) => isBillSubscription(s) && s.status === "active");
      const transactions = txnStore.transactions.filter((t) => !t.deletedAt);
      const month = date.slice(0, 7);
      const buckets = rollupMonth(transactions, month);
      // Fold in bills not yet charged this month so Needs reflects fixed
      // obligations even before a statement import (mirror of the UI logic).
      const monthTxns = transactions.filter((t) => monthKey(t.timestamp) === month);
      for (const b of bills) {
        const paid = monthTxns.some(
          (t) =>
            t.amount < 0 && Math.abs(Math.abs(t.amount) - b.amount) <= Math.max(1, b.amount * 0.05),
        );
        if (!paid) buckets.needs += subscriptionMonthlyCost(b);
      }
      const netWorth = snapshot.netWorth ?? 0;

      const fb = fallbackAdvice({
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
- Active subscriptions: ${subscriptions.filter((s) => s.status === "active").length} (~$${Math.round(monthlySubTotal).toLocaleString()}/mo)
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
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { date, items } = ctx.data as {
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
