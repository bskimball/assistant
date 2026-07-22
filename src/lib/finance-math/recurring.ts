import type { ISODate, Subscription, Transaction } from "@/lib/domain";
import {
  cleanMerchantName,
  recurringBudgetBucket,
  recurringKindOf,
  subscriptionMonthlyCost,
  toISODate,
  transactionMerchant,
} from "@/lib/domain";
import type { BudgetBucket, MonthBuckets } from "./_shared";
import {
  DAY,
  addMonthsKey,
  dateInMonth,
  daysInISOMonth,
  dollars,
  inferCadence,
  median,
  monthKey,
  normalizeMerchant,
  normalizedFinanceLabel,
} from "./_shared";

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
  /** How many matching non-deleted charges found in lookback. */
  matchCount: number;
  /** Days since last matching non-deleted charge (null if never). */
  daysSinceLastCharge: number | null;
  /** Confidence 0–1 for UI ordering. */
  confidence: number;
};

export type RecurringHealthMatch = {
  transactionId: string;
  timestamp: number;
  amount: number;
  account?: string;
  source?: Transaction["source"];
};

export type RecurringHealthNearMissReason =
  | "matched-but-deleted"
  | "amount-out-of-tolerance"
  | "name-token-mismatch"
  | "deposit"
  | "linked-to-other-recurring"
  | "user-unlinked";

export type RecurringHealthNearMiss = RecurringHealthMatch & {
  reason: RecurringHealthNearMissReason;
  deletedAt?: number;
  deletedReason?: string;
  /** Absolute difference between the charge and tracked amount, in dollars. */
  amountDelta?: number;
};

export type RecurringHealthTrace = {
  subscriptionId: string;
  window: { start: number; end: number; lookbackDays: number };
  matchedCharges: RecurringHealthMatch[];
  nearMissCandidates: RecurringHealthNearMiss[];
};

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
    const key = normalizeMerchant(transactionMerchant(t));
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
        name: cleanMerchantName(transactionMerchant(last) || "Unknown"),
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
  const descriptor = transactionMerchant(latest);

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
    const rawDescriptor = [descriptor, latest.notes].filter(Boolean).join(" ").toLowerCase();
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

function recurringDescriptorMatches(sub: Subscription, t: Transaction): boolean {
  const subName = normalizedFinanceLabel(sub.name);
  const merchant = transactionMerchant(t);
  const txnName = normalizedFinanceLabel(merchant);
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
  const rawTxnDescriptor = [merchant, t.notes].filter(Boolean).join(" ").toLowerCase();
  const hintMatches = (sub.matchHints ?? []).some((hint) => {
    const normalizedHint = hint.trim().toLowerCase();
    return !!normalizedHint && rawTxnDescriptor.includes(normalizedHint);
  });
  return nameMatches || accountMatches || hintMatches;
}

function recurringMatchRejection(
  sub: Subscription,
  t: Transaction,
): Exclude<RecurringHealthNearMissReason, "matched-but-deleted"> | null {
  if (t.amount >= 0) return "deposit";
  if (t.recurringId) return t.recurringId === sub.id ? null : "linked-to-other-recurring";
  if (t.recurringMatchSource === "user") return "user-unlinked";
  if (!amountWithinRecurringTolerance(sub, t.amount)) return "amount-out-of-tolerance";
  return recurringDescriptorMatches(sub, t) ? null : "name-token-mismatch";
}

export function recurringMatchesTransaction(sub: Subscription, t: Transaction): boolean {
  return recurringMatchRejection(sub, t) === null;
}

function normalizedAccountFamily(raw?: string): string {
  return (raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Cross-source duplicate heuristic used by both CSV import and SimpleFIN sync. */
export function crossSourceTransactionMatches(
  incoming: Pick<
    Transaction,
    "timestamp" | "amount" | "account" | "merchant" | "category" | "notes" | "source"
  >,
  existing: Transaction,
): boolean {
  if (
    existing.deletedAt ||
    !incoming.source ||
    !existing.source ||
    incoming.source === existing.source
  ) {
    return false;
  }
  if (Math.abs(incoming.amount - existing.amount) > 0.01) return false;
  if (Math.abs(incoming.timestamp - existing.timestamp) > 3 * DAY) return false;

  const incomingAccount = normalizedAccountFamily(incoming.account);
  const existingAccount = normalizedAccountFamily(existing.account);
  if (
    !incomingAccount ||
    !existingAccount ||
    (!incomingAccount.includes(existingAccount) && !existingAccount.includes(incomingAccount))
  ) {
    return false;
  }

  const incomingMerchant = transactionMerchant(incoming);
  const existingMerchant = transactionMerchant(existing);
  return recurringNamesShareToken(incomingMerchant, existingMerchant);
}

export function explainRecurringHealth(input: {
  sub: Subscription;
  transactions: Transaction[];
  now?: number;
  lookbackDays?: number;
}): RecurringHealthTrace {
  const now = input.now ?? Date.now();
  const lookbackDays = input.lookbackDays ?? 180;
  const start = now - lookbackDays * DAY;
  const matchedCharges: RecurringHealthMatch[] = [];
  const nearMissCandidates: RecurringHealthNearMiss[] = [];

  for (const transaction of input.transactions) {
    if (transaction.timestamp < start || transaction.timestamp > now) continue;
    const rejection = recurringMatchRejection(input.sub, transaction);
    // Keep the trace focused on plausible charge candidates rather than every
    // ledger row in the window. Amount misses need a matching descriptor;
    // name misses have already passed the amount gate.
    if (rejection === "deposit") continue;
    if (
      rejection === "amount-out-of-tolerance" &&
      !recurringDescriptorMatches(input.sub, transaction)
    ) {
      continue;
    }
    const base: RecurringHealthMatch = {
      transactionId: transaction.id,
      timestamp: transaction.timestamp,
      amount: dollars(Math.abs(transaction.amount)),
      account: transaction.account,
      source: transaction.source,
    };
    if (rejection === null && !transaction.deletedAt) {
      matchedCharges.push(base);
      continue;
    }
    nearMissCandidates.push({
      ...base,
      reason: rejection === null ? "matched-but-deleted" : rejection,
      deletedAt: transaction.deletedAt,
      deletedReason: transaction.deletedReason,
      amountDelta:
        rejection === "amount-out-of-tolerance"
          ? dollars(Math.abs(Math.abs(transaction.amount) - input.sub.amount))
          : undefined,
    });
  }

  matchedCharges.sort((a, b) => b.timestamp - a.timestamp);
  nearMissCandidates.sort((a, b) => b.timestamp - a.timestamp);
  return {
    subscriptionId: input.sub.id,
    window: { start, end: now, lookbackDays },
    matchedCharges,
    nearMissCandidates,
  };
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
  const deletedTransactions = input.transactions.filter(
    (t) => !!t.deletedAt && t.timestamp >= lookbackStart,
  );
  const insights: RecurringInsight[] = [];
  const subById = new Map(input.subscriptions.map((sub) => [sub.id, sub]));

  for (const sub of input.subscriptions) {
    if (sub.deletedAt || sub.status !== "active") continue;
    const matches = transactions
      .filter((t) => recurringMatchesTransaction(sub, t))
      .sort((a, b) => b.timestamp - a.timestamp);
    const latest = matches[0];
    const latestDeletedMatch = deletedTransactions
      .filter((t) => recurringMatchesTransaction(sub, t))
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    const deletedMatchReason = latestDeletedMatch
      ? `Last matching charge on ${shortDate(latestDeletedMatch.timestamp)} was deleted${latestDeletedMatch.deletedReason ? ` (${latestDeletedMatch.deletedReason})` : ""}.`
      : undefined;
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
      const deletedMatchInPrevMonth =
        latestDeletedMatch != null && monthKey(latestDeletedMatch.timestamp) === prevMonth;

      if ((hadHistoryBeforePrevMonth || deletedMatchInPrevMonth) && missedPrevMonth) {
        const kind = recurringKindOf(sub);
        insights.push({
          subscriptionId: sub.id,
          kind: "likely-canceled",
          reason:
            deletedMatchInPrevMonth && deletedMatchReason
              ? deletedMatchReason
              : `No charge in ${formatMonthKey(prevMonth)} after earlier activity (expected monthly).`,
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
    const deletedMatchWouldBeCurrent =
      latestDeletedMatch != null && now - latestDeletedMatch.timestamp <= grace * DAY;
    if ((!oldEnough && !deletedMatchWouldBeCurrent) || !missedExpectedCharge) continue;

    const staleDays = daysSinceLastCharge ?? ageDays;
    const kind = recurringKindOf(sub);
    const baseConfidence =
      (kind === "subscription" ? 0.78 : 0.62) - (daysSinceLastCharge === null ? 0.05 : 0);
    const staleBoost = Math.min(0.15, Math.max(0, staleDays - grace) / 120);
    insights.push({
      subscriptionId: sub.id,
      kind: "likely-canceled",
      reason:
        deletedMatchWouldBeCurrent && deletedMatchReason
          ? deletedMatchReason
          : daysSinceLastCharge === null
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
