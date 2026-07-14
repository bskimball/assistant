import type {
  CategoryGroup,
  FinanceAdviceItem,
  ISODate,
  Subscription,
  Transaction,
  UserProfile,
} from "@/lib/domain";
import {
  addDaysISO,
  cleanMerchantName,
  DEFAULT_BUDGET_TARGETS,
  recurringBudgetBucket,
  recurringKindOf,
  spendAmountOf,
  spendBucketOf,
  subscriptionMonthlyCost,
  toISODate,
} from "@/lib/domain";

export type BudgetBucket = "needs" | "wants" | "savings";

export interface MonthBuckets {
  needs: number;
  wants: number;
  savings: number;
  income: number;
  month: string;
}

export type CashFlowProjectionInput = {
  startMonth: string;
  months: number;
  transactions?: Transaction[];
  subscriptions?: Subscription[];
  startingCash?: number;
  monthlyIncome?: number;
  monthlyBuckets?: Partial<Record<BudgetBucket, number>>;
  includeRecurringCommitments?: boolean;
};

export type PaySchedule = {
  cadence: "monthly" | "semimonthly" | "biweekly" | "weekly";
  anchorDate?: ISODate;
  payDays?: number[];
};

export type CashFlowCalendarEvent = {
  date: ISODate;
  type: "income" | "commitment";
  label: string;
  /** Positive for income, negative for a commitment. */
  amount: number;
  projectedBalance: number;
};

export type CashFlowCalendarStatus = "healthy" | "tight" | "negative";

export type CashFlowCalendar = {
  todayISO: ISODate;
  horizonDays: number;
  startingCash: number;
  events: CashFlowCalendarEvent[];
  projectedFloor: number;
  projectedFloorDate: ISODate;
  status: CashFlowCalendarStatus;
};

export type CashFlowCalendarInput = {
  todayISO: ISODate;
  /** Number of calendar days to include, beginning with today. */
  horizonDays?: number;
  currentCashBalance: number;
  monthlyTakeHome?: number;
  paySchedule?: PaySchedule;
  subscriptions?: Subscription[];
};

export type CashFlowProjectionMonth = MonthBuckets & {
  recurringNeeds: number;
  recurringWants: number;
  recurringSavings: number;
  totalOutflow: number;
  netCashFlow: number;
  startingCash: number;
  endingCash: number;
};

export type CashFlowProjection = {
  startMonth: string;
  months: CashFlowProjectionMonth[];
  endingCash: number;
  totalIncome: number;
  totalOutflow: number;
  totalNetCashFlow: number;
};

export type DebtPayoffStrategy = "avalanche" | "snowball" | "input-order";

export type DebtPayoffDebt = {
  id: string;
  name: string;
  balance: number;
  apr?: number;
  minimumPayment: number;
};

export type DebtPayoffInput = {
  debts: DebtPayoffDebt[];
  extraMonthlyPayment?: number;
  strategy?: DebtPayoffStrategy;
  maxMonths?: number;
};

export type DebtPayoffMonth = {
  month: number;
  beginningBalance: number;
  interest: number;
  principal: number;
  payment: number;
  endingBalance: number;
  targetDebtId?: string;
};

export type DebtPayoffDebtResult = DebtPayoffDebt & {
  monthsToPayoff: number | null;
  totalInterest: number;
  totalPaid: number;
};

export type DebtPayoffSimulation = {
  strategy: DebtPayoffStrategy;
  months: number | null;
  totalInterest: number;
  totalPaid: number;
  payoffOrder: string[];
  debts: DebtPayoffDebtResult[];
  schedule: DebtPayoffMonth[];
  feasible: boolean;
};

export type EmergencyFundInput = {
  monthlyEssentialExpenses: number;
  currentSavings?: number;
  targetMonths?: number;
  minimumMonths?: number;
  monthlyContribution?: number;
};

export type EmergencyFundResult = {
  monthlyEssentialExpenses: number;
  minimumTarget: number;
  target: number;
  currentSavings: number;
  shortfall: number;
  surplus: number;
  monthsCovered: number;
  monthsToTarget: number | null;
  status: "not-started" | "building" | "funded" | "surplus";
};

export type BudgetRecurringItem = {
  id: string;
  name: string;
  kind: ReturnType<typeof recurringKindOf>;
  bucket: BudgetBucket;
  cadence: Subscription["cadence"];
  monthlyAmount: number;
  account?: string;
  seenThisMonth: boolean;
  matchedCount: number;
  matchedAmount: number;
  expectedThisMonth: number;
  expectedAmountThisMonth: number;
  remainingMonthlyAmount: number;
  /**
   * The best matching charge for this item in the month (most recent when
   * several match). Its presence is what defines `seenThisMonth`. `amount` is
   * the raw signed transaction amount (negative for a charge).
   */
  matchedTxn?: {
    id: string;
    timestamp: number;
    amount: number;
    account?: string;
    matchSource?: "ai" | "user";
    /** True when this charge is a manually-logged cash/Venmo "mark paid". */
    manual?: boolean;
  };
  /**
   * The most recent matching charge in a month *before* the one being reported,
   * when `recurringItemsForMonth` is given prior transactions. Lets pending rows
   * answer "when was this last paid?" (usually last month) so the owner can tell
   * an as-yet-unposted bill from one that has actually lapsed. Undefined when no
   * prior charge is known.
   */
  lastPaidTxn?: {
    id: string;
    timestamp: number;
    amount: number;
    account?: string;
  };
};

export type RecurringInsightKind = "amount-change" | "likely-canceled";

export type RecurringInsight = {
  subscriptionId: string;
  kind: RecurringInsightKind;
  /** Human-readable reason for the card. */
  reason: string;
  /** Suggested patch when accepting amount-change. */
  suggestedAmount?: number;
  /** Most recent matching charge amount, if any. */
  lastChargeAmount?: number;
  lastChargeAt?: number;
  /** How many matching charges found in lookback. */
  matchCount: number;
  /** Days since last matching charge (null if never). */
  daysSinceLastCharge: number | null;
  /** Confidence 0–1 for UI ordering. */
  confidence: number;
};

export type OneTimeCandidate = {
  transactionId: string;
  amount: number;
  timestamp: number;
  merchant: string;
  categoryGroup?: CategoryGroup;
  reason: string;
  confidence: number;
};

export type BudgetInsight = {
  planSpend: number;
  committedPlan: number;
  variablePlanSpend: number;
  oneTimeSpend: number;
  oneTimeCount: number;
  plannedRecurring: number;
  totalSpent: number;
  remainingCash: number;
  remainingAfterCommitted: number;
  bucketDeltas: { needs: number; wants: number; savings: number };
  projectedPlanSpend: number | null;
  lines: string[];
};

export type SafeToSpendStatus = "unavailable" | "on-track" | "tight" | "over-plan";

/**
 * A monthly budget guardrail, not a statement of available account cash.
 * Account balances, investments, and net worth are intentionally excluded.
 */
export type SafeToSpendResult = {
  status: SafeToSpendStatus;
  remainingAfterCommitted: number;
  savingsReserve: number;
  safeToSpendThisMonth: number;
  safeToSpendPerDay: number;
  remainingDays: number;
  explanation: string;
};

const DAY = 24 * 60 * 60 * 1000;

type BudgetLike = {
  monthlyTakeHome: number;
  targets: { needs: number; wants: number; savings: number };
} | null;

function dollars(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function positive(n: number | undefined): number {
  return Number.isFinite(n) && n && n > 0 ? n : 0;
}

function addMonthsKey(month: string, offset: number): string {
  const [year, monthIndex] = month.split("-").map(Number);
  if (!year || !monthIndex) return month;
  return new Date(Date.UTC(year, monthIndex - 1 + offset, 1)).toISOString().slice(0, 7);
}

export function monthKey(timestamp: number): string {
  return toISODate(timestamp).slice(0, 7);
}

/**
 * Normalize a bank descriptor for grouping/dedupe: lowercase, strip long numbers
 * (store ids, phones), drop non-alpha noise. Kept separate from
 * `normalizedFinanceLabel` (which title-cleans for display matching) so raw
 * statement variants still collapse to one merchant key.
 */
export function normalizeMerchant(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/\b\d{2,}\b/g, "") // strip long numbers (store ids, dates)
    .replace(/[^a-z& ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Map an average inter-charge gap (days) to a known cadence, or null if irregular. */
export function inferCadence(intervalDays: number): Subscription["cadence"] | null {
  if (intervalDays >= 5 && intervalDays <= 9) return "weekly";
  if (intervalDays >= 26 && intervalDays <= 35) return "monthly";
  if (intervalDays >= 350 && intervalDays <= 380) return "annual";
  return null;
}

export function normalizedFinanceLabel(raw?: string): string {
  return cleanMerchantName(raw || "").toLowerCase();
}

/** Same-day multi-membership noise; gaps shorter than this are ignored for cadence. */
const MIN_RECURRING_INTERVAL_DAYS = 3;
/**
 * Charges within this fraction of a cluster's median amount share one stream.
 * Tight on purpose: Progressive Auto vs Boat (or two gyms) often land within a
 * looser 15% band but must stay separate — merging them mixes pay days and
 * kills monthly cadence inference.
 */
const RECURRING_AMOUNT_CLUSTER_TOLERANCE = 0.05;
/**
 * Upward-only price-hike band for detect suppression. A lower amount at the
 * same merchant is treated as a different stream (second policy/membership),
 * not a "discounted" version of the stored item.
 */
const RECURRING_STORED_HIKE_TOLERANCE = 0.15;
/** Within-stream amount noise allowed after clustering (fees, rounding). */
const RECURRING_CLUSTER_STABILITY = 0.15;

/**
 * Detect new recurring outflows from the ledger. Groups by merchant, then by
 * amount band (so Progressive Auto vs Boat, or three gym memberships, become
 * separate candidates), infers cadence from median inter-charge gap after
 * dropping same-day noise, and suppresses clusters that already match a
 * stored item at a compatible amount.
 *
 * Pure: no I/O. Caller assigns `id`/`createdAt` before persisting.
 */
export function detectRecurringCandidates(input: {
  transactions: Transaction[];
  subscriptions: Subscription[];
  now?: number;
  lookbackDays?: number;
}): Array<Omit<Subscription, "id" | "createdAt">> {
  const now = input.now ?? Date.now();
  const lookbackDays = input.lookbackDays ?? 180;
  const cutoff = now - lookbackDays * DAY;
  const stored = input.subscriptions.filter((s) => !s.deletedAt);

  const groups = new Map<string, Transaction[]>();
  for (const t of input.transactions) {
    if (t.deletedAt || t.amount >= 0 || t.timestamp < cutoff) continue;
    if (t.categoryGroup === "transfer") continue;
    // Already linked to a tracked item — don't re-propose that stream.
    if (t.recurringId) continue;
    const key = normalizeMerchant(t.category || "");
    if (!key) continue;
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }

  const candidates: Array<Omit<Subscription, "id" | "createdAt"> & { merchantKey: string }> = [];
  for (const [merchantKey, charges] of groups) {
    for (const cluster of clusterTransactionsByAmount(charges)) {
      if (cluster.length < 2) continue;
      if (isRecurringClusterAlreadyTracked(cluster, stored)) continue;

      const sorted = [...cluster].sort((a, b) => a.timestamp - b.timestamp);
      const intervals: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const days = (sorted[i].timestamp - sorted[i - 1].timestamp) / DAY;
        if (days >= MIN_RECURRING_INTERVAL_DAYS) intervals.push(days);
      }
      if (!intervals.length) continue;
      const cadence = inferCadence(median(intervals));
      if (!cadence) continue;

      const amounts = sorted.map((c) => Math.abs(c.amount));
      const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      if (avgAmount <= 0) continue;
      const stable = amounts.every(
        (a) => Math.abs(a - avgAmount) <= avgAmount * RECURRING_CLUSTER_STABILITY,
      );
      if (!stable) continue;

      const last = sorted[sorted.length - 1];
      candidates.push({
        merchantKey,
        name: cleanMerchantName(last.category || last.notes || "Unknown"),
        amount: dollars(avgAmount),
        cadence,
        status: "active",
        source: "detected",
        lastSeen: last.timestamp,
      });
    }
  }

  // Same bank descriptor for two policies (Prog Northern Auto + Boat) → append
  // amount so the Detect list is distinguishable before the user renames them.
  const keyCounts = new Map<string, number>();
  for (const c of candidates) {
    keyCounts.set(c.merchantKey, (keyCounts.get(c.merchantKey) ?? 0) + 1);
  }
  const disambiguated = candidates.map(({ merchantKey, ...c }) => {
    if ((keyCounts.get(merchantKey) ?? 0) > 1) {
      return {
        ...c,
        name: `${c.name} · $${c.amount.toFixed(2)}`,
      };
    }
    return c;
  });

  disambiguated.sort((a, b) => subscriptionMonthlyCost(b) - subscriptionMonthlyCost(a));
  return disambiguated;
}

/** True when two amounts belong to the same payment stream (~5% band). */
function amountsAreSameStream(a: number, b: number): boolean {
  const basis = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(Math.abs(a) - Math.abs(b)) <= basis * RECURRING_AMOUNT_CLUSTER_TOLERANCE;
}

/** Greedy amount bands: sort by abs amount, open a new cluster when >5% off median. */
function clusterTransactionsByAmount(txns: Transaction[]): Transaction[][] {
  const sorted = [...txns].sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount));
  const clusters: Transaction[][] = [];
  for (const t of sorted) {
    const amt = Math.abs(t.amount);
    const last = clusters[clusters.length - 1];
    if (!last) {
      clusters.push([t]);
      continue;
    }
    const med = median(last.map((x) => Math.abs(x.amount)));
    if (med > 0 && Math.abs(amt - med) <= med * RECURRING_AMOUNT_CLUSTER_TOLERANCE) {
      last.push(t);
    } else {
      clusters.push([t]);
    }
  }
  return clusters;
}

/**
 * Suppress a candidate cluster when it already corresponds to a tracked item
 * at a compatible amount. Amount is gated first so a stored Progressive Auto
 * bill (wide bill tolerance) cannot swallow a Boat premium at a different
 * price, and a second gym membership is not treated as a "price cut".
 */
function isRecurringClusterAlreadyTracked(cluster: Transaction[], stored: Subscription[]): boolean {
  if (!stored.length) return false;
  const latest = [...cluster].sort((a, b) => b.timestamp - a.timestamp)[0];
  const clusterAvg =
    cluster.reduce((sum, t) => sum + Math.abs(t.amount), 0) / Math.max(cluster.length, 1);
  const descriptor = latest.category || latest.notes || "";

  for (const sub of stored) {
    const sameStream = amountsAreSameStream(clusterAvg, sub.amount);
    const modestHike =
      clusterAvg > sub.amount &&
      (clusterAvg - sub.amount) / Math.max(sub.amount, 1) <= RECURRING_STORED_HIKE_TOLERANCE;
    if (!sameStream && !modestHike) continue;

    if (recurringMatchesTransaction(sub, latest)) return true;

    const nameClose =
      normalizeMerchant(sub.name) === normalizeMerchant(descriptor) ||
      recurringNamesShareToken(sub.name, descriptor);
    const rawDescriptor = [latest.category, latest.notes].filter(Boolean).join(" ").toLowerCase();
    const hintClose = (sub.matchHints ?? []).some((hint) => {
      const normalizedHint = hint.trim().toLowerCase();
      return !!normalizedHint && rawDescriptor.includes(normalizedHint);
    });
    if (nameClose || hintClose) return true;
  }
  return false;
}

export function recurringAmountTolerance(sub: Subscription): number {
  const kind = recurringKindOf(sub);
  return kind === "bill" ? Math.max(25, sub.amount * 0.2) : Math.max(1, sub.amount * 0.05);
}

export function amountWithinRecurringTolerance(sub: Subscription, txnAmount: number): boolean {
  return Math.abs(Math.abs(txnAmount) - sub.amount) <= recurringAmountTolerance(sub);
}

export function recurringNameTokens(raw?: string): Set<string> {
  return new Set(
    normalizedFinanceLabel(raw)
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 3),
  );
}

export function recurringNamesShareToken(a?: string, b?: string): boolean {
  const aTokens = recurringNameTokens(a);
  if (aTokens.size === 0) return false;
  return [...recurringNameTokens(b)].some((token) => aTokens.has(token));
}

export function recurringMatchesTransaction(sub: Subscription, t: Transaction): boolean {
  if (t.amount >= 0) return false;
  if (t.recurringId) return t.recurringId === sub.id;
  if (t.recurringMatchSource === "user") return false;
  if (!amountWithinRecurringTolerance(sub, t.amount)) return false;

  const subName = normalizedFinanceLabel(sub.name);
  const txnName = normalizedFinanceLabel(t.category || t.notes || "");
  const nameMatches =
    !!subName &&
    !!txnName &&
    (txnName.includes(subName) ||
      subName.includes(txnName) ||
      recurringNamesShareToken(subName, txnName));
  const accountMatches =
    !!sub.account &&
    !!t.account &&
    sub.account.trim().toLowerCase() === t.account.trim().toLowerCase();
  const rawTxnDescriptor = [t.category, t.notes].filter(Boolean).join(" ").toLowerCase();
  const hintMatches = (sub.matchHints ?? []).some((hint) => {
    const normalizedHint = hint.trim().toLowerCase();
    return !!normalizedHint && rawTxnDescriptor.includes(normalizedHint);
  });
  return nameMatches || accountMatches || hintMatches;
}

function cadenceGraceDays(sub: Subscription): number {
  if (sub.cadence === "weekly") return 21;
  if (sub.cadence === "annual") return 400;
  return recurringKindOf(sub) === "loan" ? 60 : 45;
}

function shortDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function cadenceLabel(cadence: Subscription["cadence"]): string {
  return cadence === "weekly" ? "weekly" : cadence === "annual" ? "annual" : "monthly";
}

function formatMonthKey(ym: string): string {
  const [year, month] = ym.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

function recurringInsightMonthlyImpact(sub: Subscription, insight: RecurringInsight): number {
  if (insight.kind === "amount-change" && insight.suggestedAmount) {
    return Math.abs(subscriptionMonthlyCost({ ...sub, amount: insight.suggestedAmount }));
  }
  return Math.abs(subscriptionMonthlyCost(sub));
}

export function analyzeRecurringHealth(input: {
  subscriptions: Subscription[];
  transactions: Transaction[];
  /** default Date.now() */
  now?: number;
  /** default 180 */
  lookbackDays?: number;
}): RecurringInsight[] {
  const now = input.now ?? Date.now();
  const lookbackDays = input.lookbackDays ?? 180;
  const lookbackStart = now - lookbackDays * DAY;
  const transactions = input.transactions.filter(
    (t) => !t.deletedAt && t.timestamp >= lookbackStart,
  );
  const insights: RecurringInsight[] = [];
  const subById = new Map(input.subscriptions.map((sub) => [sub.id, sub]));

  for (const sub of input.subscriptions) {
    if (sub.deletedAt || sub.status !== "active") continue;
    const matches = transactions
      .filter((t) => recurringMatchesTransaction(sub, t))
      .sort((a, b) => b.timestamp - a.timestamp);
    const latest = matches[0];
    const lastChargeAt = latest?.timestamp ?? sub.lastSeen;
    const lastChargeAmount = latest ? dollars(Math.abs(latest.amount)) : undefined;
    const daysSinceLastCharge = lastChargeAt ? Math.floor((now - lastChargeAt) / DAY) : null;

    if (latest && sub.amount > 0) {
      const latestAmount = dollars(Math.abs(latest.amount));
      const delta = Math.abs(latestAmount - sub.amount);
      const relativeDelta = delta / sub.amount;
      const meaningfulDelta =
        relativeDelta >= 0.08 || delta >= Math.max(5, recurringAmountTolerance(sub) * 0.5);
      if (meaningfulDelta) {
        insights.push({
          subscriptionId: sub.id,
          kind: "amount-change",
          reason: `Last charge was $${latestAmount.toLocaleString()} on ${shortDate(latest.timestamp)} (tracked as $${dollars(sub.amount).toLocaleString()}).`,
          suggestedAmount: latestAmount,
          lastChargeAmount,
          lastChargeAt,
          matchCount: matches.length,
          daysSinceLastCharge,
          confidence: Math.min(
            0.98,
            (matches.length > 1 ? 0.9 : 0.78) +
              (daysSinceLastCharge !== null && daysSinceLastCharge <= cadenceGraceDays(sub)
                ? 0.05
                : 0),
          ),
        });
        continue;
      }
    }

    // Loans are critical and can be manually managed; do not suggest canceling
    // them based only on missing statement charges. Amount-change still applies.
    if (recurringKindOf(sub) === "loan") continue;

    const grace = cadenceGraceDays(sub);
    const ageDays = Math.floor((now - sub.createdAt) / DAY);

    if (sub.cadence === "monthly") {
      const currentMonth = monthKey(now);
      const prevMonth = addMonthsKey(currentMonth, -1);
      const monthsWithCharges = new Set(matches.map((match) => monthKey(match.timestamp)));
      const hasChargeBeforePrevMonth = [...monthsWithCharges].some((month) => month < prevMonth);
      const lastSeenBeforePrevMonth = sub.lastSeen != null && monthKey(sub.lastSeen) < prevMonth;
      const hadHistoryBeforePrevMonth = hasChargeBeforePrevMonth || lastSeenBeforePrevMonth;
      const missedPrevMonth = !monthsWithCharges.has(prevMonth);

      if (hadHistoryBeforePrevMonth && missedPrevMonth) {
        const kind = recurringKindOf(sub);
        insights.push({
          subscriptionId: sub.id,
          kind: "likely-canceled",
          reason: `No charge in ${formatMonthKey(prevMonth)} after earlier activity (expected monthly).`,
          lastChargeAmount,
          lastChargeAt,
          matchCount: matches.length,
          daysSinceLastCharge,
          confidence: kind === "subscription" ? 0.85 : 0.7,
        });
        continue;
      }
    }

    const oldEnough = ageDays > grace || (sub.lastSeen != null && now - sub.lastSeen > grace * DAY);
    const missedExpectedCharge = daysSinceLastCharge === null || daysSinceLastCharge > grace;
    if (!oldEnough || !missedExpectedCharge) continue;

    const staleDays = daysSinceLastCharge ?? ageDays;
    const kind = recurringKindOf(sub);
    const baseConfidence =
      (kind === "subscription" ? 0.78 : 0.62) - (daysSinceLastCharge === null ? 0.05 : 0);
    const staleBoost = Math.min(0.15, Math.max(0, staleDays - grace) / 120);
    insights.push({
      subscriptionId: sub.id,
      kind: "likely-canceled",
      reason:
        daysSinceLastCharge === null
          ? `No matching charge found in ${lookbackDays} days (expected ${cadenceLabel(sub.cadence)}).`
          : `No matching charge in ${staleDays} days (expected ${cadenceLabel(sub.cadence)}).`,
      lastChargeAmount,
      lastChargeAt,
      matchCount: matches.length,
      daysSinceLastCharge,
      confidence: Math.min(0.95, baseConfidence + staleBoost + (sub.lastSeen ? 0.05 : 0)),
    });
  }

  return insights.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "amount-change" ? -1 : 1;
    const confidenceDelta = b.confidence - a.confidence;
    if (Math.abs(confidenceDelta) > 0.001) return confidenceDelta;
    const aSub = subById.get(a.subscriptionId);
    const bSub = subById.get(b.subscriptionId);
    return (
      (bSub ? recurringInsightMonthlyImpact(bSub, b) : 0) -
      (aSub ? recurringInsightMonthlyImpact(aSub, a) : 0)
    );
  });
}

export function transactionsForMonth(transactions: Transaction[], month: string): Transaction[] {
  return transactions.filter((t) => monthKey(t.timestamp) === month);
}

// Transactions posted in any month strictly before `month` ("YYYY-MM"). Feeds
// `recurringItemsForMonth`'s prior-charge lookup so pending recurring rows can
// report when they were last paid. "YYYY-MM" keys compare lexicographically.
export function transactionsBeforeMonth(transactions: Transaction[], month: string): Transaction[] {
  return transactions.filter((t) => monthKey(t.timestamp) < month);
}

export function detectOneTimeCandidates(input: {
  transactions: Transaction[];
  subscriptions: Subscription[];
  month: string;
  monthlyTakeHome?: number;
  lookbackDays?: number;
  now?: number;
}): OneTimeCandidate[] {
  const now = input.now ?? Date.now();
  const lookbackStart = now - (input.lookbackDays ?? 180) * DAY;
  const activeSubscriptions = input.subscriptions.filter(
    (sub) => !sub.deletedAt && sub.status === "active",
  );
  const monthTxns = transactionsForMonth(input.transactions, input.month).filter(
    (t) => !t.deletedAt,
  );
  const expenseAbs = monthTxns
    .filter((t) => t.amount < 0 && !t.excludeFromBudget && !!spendBucketOf(t.categoryGroup))
    .map((t) => spendAmountOf(t));
  const fallbackFloor = 3 * median(expenseAbs);
  const sizeFloor = Math.max(
    100,
    input.monthlyTakeHome && input.monthlyTakeHome > 0
      ? 0.04 * input.monthlyTakeHome
      : fallbackFloor,
  );
  const lookbackTxns = input.transactions.filter(
    (t) => !t.deletedAt && t.timestamp >= lookbackStart && t.timestamp <= now,
  );

  return monthTxns
    .flatMap((t): OneTimeCandidate[] => {
      const bucket = spendBucketOf(t.categoryGroup);
      if (!bucket || t.amount >= 0 || t.excludeFromBudget || t.oneTimeSuggestionDismissed)
        return [];
      if (t.recurringId || t.recurringSuggestedId) return [];
      if (activeSubscriptions.some((sub) => recurringMatchesTransaction(sub, t))) return [];

      const merchantKey = normalizedFinanceLabel(t.category);
      if (!merchantKey) return [];
      const merchantMatches = lookbackTxns.filter(
        (candidate) => normalizedFinanceLabel(candidate.category) === merchantKey,
      );
      const distinctMonths = new Set(
        merchantMatches.map((candidate) => monthKey(candidate.timestamp)),
      );
      if (distinctMonths.size > 1) return [];

      const amount = spendAmountOf(t);
      if (amount < sizeFloor) return [];

      const atLeastDouble = amount >= 2 * sizeFloor;
      const confidence = Math.min(
        0.95,
        0.5 + (atLeastDouble ? 0.2 : 0) + (merchantMatches.length === 1 ? 0.15 : 0),
      );
      return [
        {
          transactionId: t.id,
          amount,
          timestamp: t.timestamp,
          merchant: cleanMerchantName(t.category || t.notes || "Unknown merchant"),
          categoryGroup: t.categoryGroup,
          reason: atLeastDouble
            ? "New merchant · 2× size threshold"
            : "New merchant · large charge",
          confidence,
        },
      ];
    })
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);
}

export function buildBudgetInsight(input: {
  transactions: Transaction[];
  subscriptions: Subscription[];
  month: string;
  takeHome: number;
  targets: { needs: number; wants: number; savings: number };
  now?: number;
}): BudgetInsight {
  const now = input.now ?? Date.now();
  const monthTxns = transactionsForMonth(input.transactions, input.month).filter(
    (t) => !t.deletedAt,
  );
  const planBuckets = rollupMonth(monthTxns, input.month);
  const recurring = recurringAdditionsForMonth(input.subscriptions, monthTxns, input.month);
  const plannedRecurring = dollars(recurring.needs + recurring.wants + recurring.savings);
  const planSpend = dollars(planBuckets.needs + planBuckets.wants + planBuckets.savings);
  const activeSubscriptions = input.subscriptions.filter(
    (sub) => !sub.deletedAt && sub.status === "active",
  );
  const variablePlanSpend = dollars(
    monthTxns
      .filter((t) => t.amount < 0 && !t.excludeFromBudget && !!spendBucketOf(t.categoryGroup))
      .filter(
        (t) =>
          !t.recurringId && !activeSubscriptions.some((sub) => recurringMatchesTransaction(sub, t)),
      )
      .reduce((sum, t) => sum + spendAmountOf(t), 0),
  );
  const fixedPlanSpend = dollars(Math.max(0, planSpend - variablePlanSpend));
  const committedPlan = dollars(planSpend + plannedRecurring);
  const oneTimeTxns = monthTxns.filter(
    (t) => t.amount < 0 && t.excludeFromBudget && !!spendBucketOf(t.categoryGroup),
  );
  const oneTimeSpend = dollars(oneTimeTxns.reduce((sum, t) => sum + spendAmountOf(t), 0));
  const totalSpent = dollars(planSpend + oneTimeSpend);
  const takeHome = positive(input.takeHome);
  const actualNeeds = dollars(planBuckets.needs + recurring.needs);
  const actualWants = dollars(planBuckets.wants + recurring.wants);
  const actualSavings = dollars(planBuckets.savings + recurring.savings);
  const bucketDeltas = {
    needs: dollars(actualNeeds - takeHome * input.targets.needs),
    wants: dollars(actualWants - takeHome * input.targets.wants),
    savings: dollars(takeHome * input.targets.savings - actualSavings),
  };
  const currentMonth = monthKey(now);
  const dayOfMonth = Math.max(1, new Date(now).getUTCDate());
  const daysInMonth = daysInMonthUTC(now);
  const projectedVariable = dollars((variablePlanSpend / dayOfMonth) * daysInMonth);
  const projectedPlanSpend =
    input.month === currentMonth
      ? dollars(fixedPlanSpend + plannedRecurring + projectedVariable)
      : null;

  const lines: string[] = [];
  if (takeHome > 0) {
    lines.push(
      `Committed so far: $${planSpend.toLocaleString()} plan + $${plannedRecurring.toLocaleString()} remaining recurring = $${committedPlan.toLocaleString()} of $${dollars(takeHome).toLocaleString()} take-home.`,
    );
  }
  const projectedVariableExtra = dollars(projectedVariable - variablePlanSpend);
  if (
    projectedPlanSpend !== null &&
    takeHome > 0 &&
    dayOfMonth >= 5 &&
    variablePlanSpend > 0 &&
    projectedVariableExtra > Math.max(50, 0.02 * takeHome)
  ) {
    lines.push(
      projectedPlanSpend > takeHome
        ? `Variable spending is on track to push plan load over take-home (~$${projectedPlanSpend.toLocaleString()} vs $${dollars(takeHome).toLocaleString()}).`
        : `At this pace, variable spending projects to $${projectedVariable.toLocaleString()} this month; total plan load ~$${projectedPlanSpend.toLocaleString()} (take-home $${dollars(takeHome).toLocaleString()}).`,
    );
  }
  if (takeHome > 0) {
    const pressure = [
      { key: "needs", value: bucketDeltas.needs },
      { key: "wants", value: bucketDeltas.wants },
      { key: "savings", value: bucketDeltas.savings },
    ].sort((a, b) => b.value - a.value)[0];
    if (pressure.value > 0) {
      lines.push(
        pressure.key === "needs"
          ? `Needs are $${dollars(pressure.value).toLocaleString()} over plan. Verify bills, loan payments, and one-time charges first.`
          : pressure.key === "wants"
            ? `Wants are $${dollars(pressure.value).toLocaleString()} over plan. Move essentials or mark true one-time charges.`
            : `Savings is $${dollars(pressure.value).toLocaleString()} short of the monthly target. Add or verify an automatic transfer.`,
      );
    } else {
      lines.push("This month is on plan so far. Keep verifying recurring payments as they land.");
    }
  }
  const biggestOneTime = oneTimeTxns.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
  if (biggestOneTime) {
    lines.push(
      `Biggest one-time: ${cleanMerchantName(biggestOneTime.category || biggestOneTime.notes || "Unknown merchant")}, $${dollars(Math.abs(biggestOneTime.amount)).toLocaleString()} — tracked, not counted against the plan.`,
    );
  }
  if (bucketDeltas.savings > 0) {
    lines.push(
      `Savings shortfall: $${dollars(bucketDeltas.savings).toLocaleString()} left to hit this month’s target.`,
    );
  }

  return {
    planSpend,
    committedPlan,
    variablePlanSpend,
    oneTimeSpend,
    oneTimeCount: oneTimeTxns.length,
    plannedRecurring,
    totalSpent,
    remainingCash: dollars(takeHome - totalSpent),
    remainingAfterCommitted: dollars(takeHome - committedPlan - oneTimeSpend),
    bucketDeltas,
    projectedPlanSpend,
    lines: lines.slice(0, 4),
  };
}

function daysInMonthUTC(timestamp: number): number {
  const d = new Date(timestamp);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * Derive a household's remaining monthly discretionary budget after known plan
 * spending, unpaid recurring commitments, excluded one-time costs, and the
 * still-unmet savings target. This deliberately composes `buildBudgetInsight`
 * so all budget surfaces treat recurring and excluded transactions consistently.
 */
export function calculateSafeToSpend(input: {
  budget: BudgetLike;
  transactions: Transaction[];
  subscriptions: Subscription[];
  date: string;
}): SafeToSpendResult {
  const [year, month, day] = input.date.split("-").map(Number);
  const requestedAt = Date.UTC(year, month - 1, day);
  const daysInMonth = daysInMonthUTC(requestedAt);
  const remainingDays = Math.max(1, daysInMonth - day + 1);

  if (!input.budget || positive(input.budget.monthlyTakeHome) === 0) {
    return {
      status: "unavailable",
      remainingAfterCommitted: 0,
      savingsReserve: 0,
      safeToSpendThisMonth: 0,
      safeToSpendPerDay: 0,
      remainingDays,
      explanation: "Set monthly take-home pay to calculate this budget guardrail.",
    };
  }

  const requestedDayEnd = requestedAt + DAY - 1;
  const insight = buildBudgetInsight({
    transactions: input.transactions.filter(
      (transaction) => transaction.timestamp <= requestedDayEnd,
    ),
    subscriptions: input.subscriptions,
    month: input.date.slice(0, 7),
    takeHome: input.budget.monthlyTakeHome,
    targets: input.budget.targets,
    now: requestedAt,
  });
  const savingsReserve = dollars(Math.max(0, insight.bucketDeltas.savings));
  const safeToSpendThisMonth = dollars(
    Math.max(0, insight.remainingAfterCommitted - savingsReserve),
  );
  const safeToSpendPerDay = dollars(safeToSpendThisMonth / remainingDays);
  const status: SafeToSpendStatus =
    insight.remainingAfterCommitted < 0
      ? "over-plan"
      : safeToSpendThisMonth <= input.budget.monthlyTakeHome * 0.1
        ? "tight"
        : "on-track";
  const explanation =
    status === "over-plan"
      ? `Committed spending and one-time costs are $${Math.abs(insight.remainingAfterCommitted).toLocaleString()} over monthly take-home.`
      : status === "tight"
        ? `After commitments and a $${savingsReserve.toLocaleString()} savings reserve, keep remaining spending to $${safeToSpendThisMonth.toLocaleString()}.`
        : `After commitments and a $${savingsReserve.toLocaleString()} savings reserve, $${safeToSpendThisMonth.toLocaleString()} remains for this month.`;

  return {
    status,
    remainingAfterCommitted: insight.remainingAfterCommitted,
    savingsReserve,
    safeToSpendThisMonth,
    safeToSpendPerDay,
    remainingDays,
    explanation,
  };
}

/** Return a month key offset without converting an ISO day through local time. */
function addMonthsToKey(month: string, offset: number): string {
  const [year, monthIndex] = month.split("-").map(Number);
  const shifted = year * 12 + (monthIndex - 1) + offset;
  const nextYear = Math.floor(shifted / 12);
  const nextMonth = (shifted % 12) + 1;
  return `${nextYear.toString().padStart(4, "0")}-${nextMonth.toString().padStart(2, "0")}`;
}

function daysInISOMonth(month: string): number {
  const [year, monthIndex] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
}

function dateInMonth(month: string, day: number): ISODate {
  const safeDay = Math.min(Math.max(1, Math.floor(day)), daysInISOMonth(month));
  return `${month}-${safeDay.toString().padStart(2, "0")}`;
}

function nextMonthlyDate(date: ISODate, months = 1): ISODate {
  return dateInMonth(addMonthsToKey(date.slice(0, 7), months), Number(date.slice(8, 10)));
}

function paydayDates(
  todayISO: ISODate,
  endISO: ISODate,
  monthlyTakeHome: number,
  schedule?: PaySchedule,
): Array<Omit<CashFlowCalendarEvent, "projectedBalance">> {
  if (positive(monthlyTakeHome) === 0) return [];
  const cadence = schedule?.cadence ?? "monthly";
  const payDays = (schedule?.payDays ?? []).filter(
    (day) => Number.isInteger(day) && day >= 1 && day <= 31,
  );
  const count =
    cadence === "semimonthly"
      ? 2
      : cadence === "biweekly"
        ? 26 / 12
        : cadence === "weekly"
          ? 52 / 12
          : 1;
  const amount = dollars(monthlyTakeHome / count);
  const dates: ISODate[] = [];

  if (cadence === "monthly" || cadence === "semimonthly") {
    // Without configured payday timing, assume monthly take-home lands on the 1st.
    const anchorDay = schedule?.anchorDate ? Number(schedule.anchorDate.slice(8, 10)) : 1;
    const days = [
      ...new Set(payDays.length ? payDays : cadence === "semimonthly" ? [1, 15] : [anchorDay]),
    ];
    for (let monthOffset = 0; ; monthOffset++) {
      const month = addMonthsToKey(todayISO.slice(0, 7), monthOffset);
      if (`${month}-01` > endISO) break;
      for (const day of days) {
        const date = dateInMonth(month, day);
        if (date >= todayISO && date <= endISO) dates.push(date);
      }
    }
  } else {
    const interval = cadence === "weekly" ? 7 : 14;
    let date = schedule?.anchorDate ?? todayISO;
    while (date > todayISO) date = addDaysISO(date, -interval);
    while (date < todayISO) date = addDaysISO(date, interval);
    while (date <= endISO) {
      dates.push(date);
      date = addDaysISO(date, interval);
    }
  }

  return dates.map((date) => ({ date, type: "income", label: "Payday", amount }));
}

function nextCommitmentDate(date: ISODate, cadence: Subscription["cadence"]): ISODate {
  if (cadence === "weekly") return addDaysISO(date, 7);
  if (cadence === "monthly") return nextMonthlyDate(date);
  return nextMonthlyDate(date, 12);
}

/**
 * Project cash/checking/savings through dated paydays and known recurring charges.
 * This is a cash timing view, distinct from the monthly safe-to-spend budget guardrail.
 */
export function calculateCashFlowCalendar(input: CashFlowCalendarInput): CashFlowCalendar {
  const horizonDays = Math.max(1, Math.floor(input.horizonDays ?? 30));
  const endISO = addDaysISO(input.todayISO, horizonDays - 1);
  const events: Array<Omit<CashFlowCalendarEvent, "projectedBalance">> = paydayDates(
    input.todayISO,
    endISO,
    positive(input.monthlyTakeHome),
    input.paySchedule,
  );

  for (const subscription of input.subscriptions ?? []) {
    if (subscription.deletedAt || subscription.status !== "active" || !subscription.nextChargeDate)
      continue;
    let date = subscription.nextChargeDate;
    while (date < input.todayISO) date = nextCommitmentDate(date, subscription.cadence);
    while (date <= endISO) {
      events.push({
        date,
        type: "commitment",
        label: subscription.name,
        amount: -dollars(Math.abs(subscription.amount)),
      });
      date = nextCommitmentDate(date, subscription.cadence);
    }
  }

  events.sort((a, b) =>
    a.date === b.date
      ? a.type === b.type
        ? a.label.localeCompare(b.label)
        : a.type === "income"
          ? -1
          : 1
      : a.date.localeCompare(b.date),
  );

  let balance = dollars(input.currentCashBalance);
  let projectedFloor = balance;
  let projectedFloorDate = input.todayISO;
  const projectedEvents = events.map((event) => {
    balance = dollars(balance + event.amount);
    if (balance < projectedFloor) {
      projectedFloor = balance;
      projectedFloorDate = event.date;
    }
    return { ...event, projectedBalance: balance };
  });
  const tightThreshold = positive(input.monthlyTakeHome) * 0.1;
  const status: CashFlowCalendarStatus =
    projectedFloor < 0 ? "negative" : projectedFloor <= tightThreshold ? "tight" : "healthy";

  return {
    todayISO: input.todayISO,
    horizonDays,
    startingCash: dollars(input.currentCashBalance),
    events: projectedEvents,
    projectedFloor,
    projectedFloorDate,
    status,
  };
}

export function buildCashFlowProjection(input: CashFlowProjectionInput): CashFlowProjection {
  const projectionMonths = Math.max(0, Math.floor(input.months));
  const transactions = input.transactions ?? [];
  const subscriptions = input.subscriptions ?? [];
  const includeRecurring = input.includeRecurringCommitments ?? true;
  let runningCash = dollars(input.startingCash ?? 0);
  const months: CashFlowProjectionMonth[] = [];

  for (let i = 0; i < projectionMonths; i++) {
    const month = addMonthsKey(input.startMonth, i);
    const monthTxns = transactionsForMonth(transactions, month).filter((t) => !t.deletedAt);
    const rolled = rollupMonth(monthTxns, month);
    const income = dollars(input.monthlyIncome ?? rolled.income);
    const needs = dollars(input.monthlyBuckets?.needs ?? rolled.needs);
    const wants = dollars(input.monthlyBuckets?.wants ?? rolled.wants);
    const savings = dollars(input.monthlyBuckets?.savings ?? rolled.savings);
    const recurring = includeRecurring
      ? recurringAdditionsForMonth(subscriptions, monthTxns, month)
      : { needs: 0, wants: 0, savings: 0 };
    const recurringNeeds = dollars(recurring.needs);
    const recurringWants = dollars(recurring.wants);
    const recurringSavings = dollars(recurring.savings);
    const totalOutflow = dollars(
      needs + wants + savings + recurringNeeds + recurringWants + recurringSavings,
    );
    const netCashFlow = dollars(income - totalOutflow);
    const startingCash = runningCash;
    runningCash = dollars(runningCash + netCashFlow);
    months.push({
      month,
      income,
      needs,
      wants,
      savings,
      recurringNeeds,
      recurringWants,
      recurringSavings,
      totalOutflow,
      netCashFlow,
      startingCash,
      endingCash: runningCash,
    });
  }

  const totalIncome = dollars(months.reduce((sum, m) => sum + m.income, 0));
  const totalOutflow = dollars(months.reduce((sum, m) => sum + m.totalOutflow, 0));
  const totalNetCashFlow = dollars(months.reduce((sum, m) => sum + m.netCashFlow, 0));

  return {
    startMonth: input.startMonth,
    months,
    endingCash: runningCash,
    totalIncome,
    totalOutflow,
    totalNetCashFlow,
  };
}

export function rollupMonth(transactions: Transaction[], month: string): MonthBuckets {
  const buckets: MonthBuckets = {
    needs: 0,
    wants: 0,
    savings: 0,
    income: 0,
    month,
  };
  for (const t of transactions) {
    if (t.deletedAt || monthKey(t.timestamp) !== month) continue;
    if (t.excludeFromBudget) continue;
    if (t.categoryGroup === "income") {
      buckets.income += t.amount;
      continue;
    }
    const bucket = spendBucketOf(t.categoryGroup);
    if (bucket) buckets[bucket] += spendAmountOf(t);
  }
  return buckets;
}

function weeklyPaymentsInMonth(month: string, anchorDate?: ISODate): number | null {
  if (!anchorDate) return null;
  const targetWeekday = new Date(`${anchorDate}T12:00:00Z`).getUTCDay();
  const days = daysInISOMonth(month);
  let count = 0;
  for (let day = 1; day <= days; day++) {
    const date = dateInMonth(month, day);
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === targetWeekday) count++;
  }
  return count;
}

function weeklyAnchorDate(sub: Subscription, priorTxns?: Transaction[]): ISODate | undefined {
  const latestPrior = priorTxns
    ?.filter((transaction) => recurringMatchesTransaction(sub, transaction))
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  return (
    sub.nextChargeDate ??
    (latestPrior ? toISODate(latestPrior.timestamp) : undefined) ??
    (sub.lastSeen ? toISODate(sub.lastSeen) : undefined)
  );
}

function expectedPaymentsForMonth(
  sub: Subscription,
  month: string,
  priorTxns?: Transaction[],
): number {
  if (sub.cadence === "monthly") return 1;
  if (sub.cadence !== "weekly") return 0;
  return weeklyPaymentsInMonth(month, weeklyAnchorDate(sub, priorTxns)) ?? 4;
}

function remainingRecurringAmount(
  sub: Subscription,
  expectedAmount: number,
  matchedAmount: number,
  seenThisMonth: boolean,
): number {
  if (sub.cadence === "weekly") return Math.max(0, expectedAmount - matchedAmount);
  return seenThisMonth ? 0 : expectedAmount;
}

export function recurringItemsForMonth(
  subscriptions: Subscription[],
  monthTxns: Transaction[],
  // Transactions from months *before* `monthTxns` (e.g. via `transactionsBeforeMonth`).
  // When supplied, each item gets `lastPaidTxn` — the most recent prior charge —
  // so pending rows can show when they were last paid. Optional so callers that
  // only need monthly totals skip the extra sweep.
  priorTxns?: Transaction[],
  requestedMonth?: string,
): Record<BudgetBucket, BudgetRecurringItem[]> {
  const month =
    requestedMonth ?? (monthTxns[0] ? monthKey(monthTxns[0].timestamp) : monthKey(Date.now()));
  const items: Record<BudgetBucket, BudgetRecurringItem[]> = {
    needs: [],
    wants: [],
    savings: [],
  };
  for (const sub of subscriptions) {
    if (sub.status !== "active") continue;
    const bucket = recurringBudgetBucket(sub);
    // Best matching charge this month: when several match, keep the most recent
    // so the row reports the latest payment. seenThisMonth derives from it.
    const matches = monthTxns.filter((t) => recurringMatchesTransaction(sub, t));
    const matched = matches.reduce<Transaction | null>(
      (best, t) => (!best || t.timestamp > best.timestamp ? t : best),
      null,
    );
    // Latest charge in an earlier month, so pending rows can show "last paid".
    const lastPaid = priorTxns
      ? priorTxns.reduce<Transaction | null>(
          (best, t) =>
            recurringMatchesTransaction(sub, t) && (!best || t.timestamp > best.timestamp)
              ? t
              : best,
          null,
        )
      : null;
    const expectedThisMonth = expectedPaymentsForMonth(sub, month, priorTxns);
    const monthlyAmount = subscriptionMonthlyCost(sub);
    const exactWeeklyPayments =
      sub.cadence === "weekly"
        ? weeklyPaymentsInMonth(month, weeklyAnchorDate(sub, priorTxns))
        : null;
    const expectedAmountThisMonth =
      exactWeeklyPayments !== null ? dollars(sub.amount * exactWeeklyPayments) : monthlyAmount;
    const matchedAmount = matches.reduce((sum, t) => sum + Math.abs(t.amount), 0);
    const seenThisMonth = matched !== null;
    items[bucket].push({
      id: sub.id,
      name: sub.name,
      kind: recurringKindOf(sub),
      bucket,
      cadence: sub.cadence,
      monthlyAmount,
      account: sub.account,
      seenThisMonth,
      matchedCount: matches.length,
      matchedAmount,
      expectedThisMonth,
      expectedAmountThisMonth,
      remainingMonthlyAmount: remainingRecurringAmount(
        sub,
        expectedAmountThisMonth,
        matchedAmount,
        seenThisMonth,
      ),
      matchedTxn: matched
        ? {
            id: matched.id,
            timestamp: matched.timestamp,
            amount: matched.amount,
            account: matched.account,
            matchSource: matched.recurringMatchSource,
            manual: matched.source === "manual",
          }
        : undefined,
      lastPaidTxn: lastPaid
        ? {
            id: lastPaid.id,
            timestamp: lastPaid.timestamp,
            amount: lastPaid.amount,
            account: lastPaid.account,
          }
        : undefined,
    });
  }
  for (const bucket of ["needs", "wants", "savings"] as const) {
    items[bucket].sort((a, b) => b.monthlyAmount - a.monthlyAmount);
  }
  return items;
}

export function recurringAdditionsFromItems(
  items: Record<BudgetBucket, BudgetRecurringItem[]>,
): Record<BudgetBucket, number> {
  return {
    needs: items.needs.reduce((sum, item) => sum + item.remainingMonthlyAmount, 0),
    wants: items.wants.reduce((sum, item) => sum + item.remainingMonthlyAmount, 0),
    savings: items.savings.reduce((sum, item) => sum + item.remainingMonthlyAmount, 0),
  };
}

export function recurringAdditionsForMonth(
  subscriptions: Subscription[],
  monthTxns: Transaction[],
  month?: string,
): Record<BudgetBucket, number> {
  return recurringAdditionsFromItems(
    recurringItemsForMonth(subscriptions, monthTxns, undefined, month),
  );
}

export function addUnseenRecurringToBuckets(
  buckets: Pick<MonthBuckets, BudgetBucket>,
  subscriptions: Subscription[],
  monthTxns: Transaction[],
): Record<BudgetBucket, number> {
  const additions = recurringAdditionsForMonth(subscriptions, monthTxns);
  buckets.needs += additions.needs;
  buckets.wants += additions.wants;
  buckets.savings += additions.savings;
  return additions;
}

function debtPriority(
  a: DebtPayoffDebt,
  b: DebtPayoffDebt,
  strategy: DebtPayoffStrategy,
  order: Map<string, number>,
): number {
  if (strategy === "avalanche") {
    const aprDelta = positive(b.apr) - positive(a.apr);
    if (aprDelta !== 0) return aprDelta;
  } else if (strategy === "snowball") {
    const balanceDelta = positive(a.balance) - positive(b.balance);
    if (balanceDelta !== 0) return balanceDelta;
  }
  return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
}

export function simulateDebtPayoff(input: DebtPayoffInput): DebtPayoffSimulation {
  const strategy = input.strategy ?? "avalanche";
  const maxMonths = Math.max(1, Math.floor(input.maxMonths ?? 600));
  const extraMonthlyPayment = positive(input.extraMonthlyPayment);
  const order = new Map(input.debts.map((d, index) => [d.id, index]));
  const states = input.debts
    .filter((d) => positive(d.balance) > 0)
    .map((d) => ({
      debt: {
        ...d,
        balance: dollars(positive(d.balance)),
        apr: positive(d.apr),
        minimumPayment: dollars(positive(d.minimumPayment)),
      },
      balance: dollars(positive(d.balance)),
      totalInterest: 0,
      totalPaid: 0,
      monthsToPayoff: null as number | null,
    }));
  const schedule: DebtPayoffMonth[] = [];
  const payoffOrder: string[] = [];

  if (!states.length) {
    return {
      strategy,
      months: 0,
      totalInterest: 0,
      totalPaid: 0,
      payoffOrder,
      debts: [],
      schedule,
      feasible: true,
    };
  }

  for (let month = 1; month <= maxMonths; month++) {
    const active = states.filter((s) => s.balance > 0);
    if (!active.length) break;
    const target = [...active].sort((a, b) => debtPriority(a.debt, b.debt, strategy, order))[0];
    let extraPool = extraMonthlyPayment;

    for (const state of active) {
      const beginningBalance = state.balance;
      const monthlyRate = positive(state.debt.apr) / 100 / 12;
      const interest = dollars(beginningBalance * monthlyRate);
      const balanceWithInterest = dollars(beginningBalance + interest);
      const scheduledPayment = dollars(Math.min(balanceWithInterest, state.debt.minimumPayment));
      state.balance = dollars(balanceWithInterest - scheduledPayment);
      state.totalInterest = dollars(state.totalInterest + interest);
      state.totalPaid = dollars(state.totalPaid + scheduledPayment);
      schedule.push({
        month,
        beginningBalance,
        interest,
        principal: dollars(scheduledPayment - interest),
        payment: scheduledPayment,
        endingBalance: state.balance,
        targetDebtId: target?.debt.id,
      });
    }

    while (extraPool > 0) {
      const extraTarget = [...states]
        .filter((s) => s.balance > 0)
        .sort((a, b) => debtPriority(a.debt, b.debt, strategy, order))[0];
      if (!extraTarget) break;
      const extraPayment = dollars(Math.min(extraPool, extraTarget.balance));
      extraTarget.balance = dollars(extraTarget.balance - extraPayment);
      extraTarget.totalPaid = dollars(extraTarget.totalPaid + extraPayment);
      extraPool = dollars(extraPool - extraPayment);
      schedule.push({
        month,
        beginningBalance: dollars(extraTarget.balance + extraPayment),
        interest: 0,
        principal: extraPayment,
        payment: extraPayment,
        endingBalance: extraTarget.balance,
        targetDebtId: extraTarget.debt.id,
      });
      if (extraTarget.balance === 0 && extraTarget.monthsToPayoff === null) {
        extraTarget.monthsToPayoff = month;
        payoffOrder.push(extraTarget.debt.id);
      }
    }

    for (const state of states) {
      if (state.balance === 0 && state.monthsToPayoff === null) {
        state.monthsToPayoff = month;
        payoffOrder.push(state.debt.id);
      }
    }

    const impossible = states.some((s) => {
      const monthlyRate = positive(s.debt.apr) / 100 / 12;
      return s.balance > 0 && s.debt.minimumPayment <= dollars(s.balance * monthlyRate);
    });
    if (impossible && extraMonthlyPayment === 0) break;
  }

  const feasible = states.every((s) => s.balance === 0);
  const paidMonths = states.map((s) => s.monthsToPayoff ?? 0);
  const months = feasible ? Math.max(...paidMonths) : null;
  const debts = states.map((s) => ({
    ...s.debt,
    monthsToPayoff: s.monthsToPayoff,
    totalInterest: dollars(s.totalInterest),
    totalPaid: dollars(s.totalPaid),
  }));
  const totalInterest = dollars(debts.reduce((sum, d) => sum + d.totalInterest, 0));
  const totalPaid = dollars(debts.reduce((sum, d) => sum + d.totalPaid, 0));

  return {
    strategy,
    months,
    totalInterest,
    totalPaid,
    payoffOrder,
    debts,
    schedule,
    feasible,
  };
}

export function calculateEmergencyFund(input: EmergencyFundInput): EmergencyFundResult {
  const monthlyEssentialExpenses = dollars(positive(input.monthlyEssentialExpenses));
  const currentSavings = dollars(positive(input.currentSavings));
  const minimumMonths = positive(input.minimumMonths) || 3;
  const targetMonths = Math.max(minimumMonths, positive(input.targetMonths) || 6);
  const monthlyContribution = dollars(positive(input.monthlyContribution));
  const minimumTarget = dollars(monthlyEssentialExpenses * minimumMonths);
  const target = dollars(monthlyEssentialExpenses * targetMonths);
  const shortfall = dollars(Math.max(0, target - currentSavings));
  const surplus = dollars(Math.max(0, currentSavings - target));
  const monthsCovered =
    monthlyEssentialExpenses > 0 ? dollars(currentSavings / monthlyEssentialExpenses) : 0;
  const monthsToTarget =
    shortfall === 0
      ? 0
      : monthlyContribution > 0
        ? Math.ceil(shortfall / monthlyContribution)
        : null;
  const status =
    surplus > 0
      ? "surplus"
      : currentSavings >= target
        ? "funded"
        : currentSavings >= minimumTarget
          ? "building"
          : "not-started";

  return {
    monthlyEssentialExpenses,
    minimumTarget,
    target,
    currentSavings,
    shortfall,
    surplus,
    monthsCovered,
    monthsToTarget,
    status,
  };
}

export function fallbackFinanceAdvice(args: {
  budget: BudgetLike;
  buckets: MonthBuckets;
  subscriptions: Subscription[];
  netWorth: number;
  profile: UserProfile;
  /** Active loans (for a highest-APR payoff/refinance note). Optional. */
  loans?: Subscription[];
  /** Idle cash-like balance across accounts, for an emergency-fund note. Optional. */
  cashOnHand?: number;
}): FinanceAdviceItem[] {
  const { budget, buckets, subscriptions, netWorth, profile, loans = [], cashOnHand } = args;
  const items: FinanceAdviceItem[] = [];
  const takeHome = budget?.monthlyTakeHome ?? buckets.income;
  const targets = budget?.targets ?? DEFAULT_BUDGET_TARGETS;

  if (takeHome > 0) {
    const checks: { bucket: BudgetBucket; actual: number }[] = [
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

  const active = subscriptions.filter((s) => s.status === "active");
  if (active.length) {
    const monthlyTotal = active.reduce((s, x) => s + subscriptionMonthlyCost(x), 0);
    const stale = active.filter((s) => s.lastSeen && Date.now() - s.lastSeen > 75 * DAY);
    const largest = active.reduce((a, b) =>
      subscriptionMonthlyCost(b) > subscriptionMonthlyCost(a) ? b : a,
    );
    const largestCost = subscriptionMonthlyCost(largest);
    items.push({
      category: "subscriptions",
      text: `You're carrying ${active.length} cuttable subscriptions totaling ~$${Math.round(monthlyTotal).toLocaleString()}/mo ($${Math.round(monthlyTotal * 12).toLocaleString()}/yr). The largest is ${largest.name} at ~$${Math.round(largestCost).toLocaleString()}/mo — cutting just that saves $${Math.round(largestCost * 12).toLocaleString()}/yr.${stale.length ? ` ${stale.length} haven't charged in 75+ days — cancel candidates.` : ""}`,
      action: `Cut ${largest.name}`,
    });
  }

  // Highest-APR loan: a payoff/refinance nudge grounded in the actual rate.
  const activeLoans = loans.filter((s) => s.status === "active" && (s.apr ?? 0) > 0);
  if (activeLoans.length) {
    const worst = activeLoans.reduce((a, b) => ((b.apr ?? 0) > (a.apr ?? 0) ? b : a));
    const payment = subscriptionMonthlyCost(worst);
    const balanceNote = worst.balance
      ? ` on a $${Math.round(worst.balance).toLocaleString()} balance`
      : "";
    items.push({
      category: "budget",
      text: `${worst.name} carries the highest rate at ${worst.apr}% APR${balanceNote} (~$${Math.round(payment).toLocaleString()}/mo). ${(worst.apr ?? 0) >= 7 ? "Refinancing or throwing surplus at this beats most guaranteed returns." : "Keep paying as scheduled; the rate is low enough not to rush."}`,
      action: (worst.apr ?? 0) >= 7 ? `Target ${worst.name} payoff` : "Review loan rate",
    });
  }

  // Idle cash: money sitting in checking beyond a healthy emergency buffer is
  // an opportunity cost. Compare cash-like balances to ~6 months of needs.
  // buckets.needs is only month-to-date, so mid-month it understates a full
  // month — use the 50/30/20 needs target as a floor when take-home is known.
  const monthlyNeeds = Math.max(buckets.needs, takeHome > 0 ? takeHome * targets.needs : 0);
  if (typeof cashOnHand === "number" && cashOnHand > 0 && monthlyNeeds > 0) {
    const sixMonths = monthlyNeeds * 6;
    if (cashOnHand > sixMonths) {
      const idle = cashOnHand - sixMonths;
      items.push({
        category: "investing",
        text: `You're holding ~$${Math.round(cashOnHand).toLocaleString()} in cash — about $${Math.round(idle).toLocaleString()} above a 6-month ($${Math.round(sixMonths).toLocaleString()}) emergency fund. Consider moving the excess into your risk-appropriate index allocation or a high-yield account so it isn't losing to inflation.`,
        action: "Deploy idle cash",
      });
    }
  }

  const riskNote =
    profile.riskTolerance === "aggressive"
      ? "Given your aggressive risk tolerance, keep a high equity allocation but make sure you hold 3-6 months of expenses in cash first."
      : profile.riskTolerance === "conservative"
        ? "With a conservative profile, prioritize an emergency fund and broad low-cost index funds over individual picks."
        : "Favor broad low-cost index funds; increase 401k contribution at least to any employer match.";
  items.push({
    category: "investing",
    text: `${riskNote} Max free money first: confirm you're capturing your full ADP 401k match.`,
    action: "Check 401k match",
  });

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
  const skillList = profile.skills?.length ? profile.skills : undefined;
  const skillNote = skillList
    ? ` Build it on a skill you can already sell (${skillList.slice(0, 2).join(", ")}) — e.g. a productized ${skillList[0]} offer or a fixed-scope audit.`
    : profile.goals?.length
      ? ` Leverage what you already do (${profile.goals.slice(0, 2).join(", ")}).`
      : " Pick one measurable lane: raise/client-rate conversation, consulting audit, or productized skill offer.";
  items.push({
    category: "earn",
    text: `Run a $${Math.round(revenueTarget).toLocaleString()}/mo revenue experiment to accelerate net worth (currently $${netWorth.toLocaleString()}).${surplus > 0 ? ` You have ~$${Math.round(surplus).toLocaleString()}/mo of surplus to seed it.` : ""}${skillNote}`,
    action: skillList ? `Sell ${skillList[0]}` : "Start revenue experiment",
  });

  return items;
}
