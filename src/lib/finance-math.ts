import type { FinanceAdviceItem, Subscription, Transaction, UserProfile } from "@/lib/domain";
import {
  cleanMerchantName,
  DEFAULT_BUDGET_TARGETS,
  recurringBudgetBucket,
  recurringKindOf,
  spendBucketOf,
  subscriptionMonthlyCost,
} from "@/lib/domain";

export type BudgetBucket = "needs" | "wants" | "savings";

export interface MonthBuckets {
  needs: number;
  wants: number;
  savings: number;
  income: number;
  month: string;
}

export type BudgetRecurringItem = {
  id: string;
  name: string;
  kind: ReturnType<typeof recurringKindOf>;
  cadence: Subscription["cadence"];
  monthlyAmount: number;
  account?: string;
  seenThisMonth: boolean;
};

const DAY = 24 * 60 * 60 * 1000;

type BudgetLike = {
  monthlyTakeHome: number;
  targets: { needs: number; wants: number; savings: number };
} | null;

export function monthKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

export function normalizedFinanceLabel(raw?: string): string {
  return cleanMerchantName(raw || "").toLowerCase();
}

export function recurringMatchesTransaction(sub: Subscription, t: Transaction): boolean {
  if (t.amount >= 0) return false;
  const amount = Math.abs(t.amount);
  const amountMatches = Math.abs(amount - sub.amount) <= Math.max(1, sub.amount * 0.05);
  if (!amountMatches) return false;

  const subName = normalizedFinanceLabel(sub.name);
  const txnName = normalizedFinanceLabel(t.category || t.notes || "");
  const nameMatches =
    !!subName && !!txnName && (txnName.includes(subName) || subName.includes(txnName));
  const accountMatches =
    !!sub.account &&
    !!t.account &&
    sub.account.trim().toLowerCase() === t.account.trim().toLowerCase();
  return nameMatches || accountMatches;
}

export function transactionsForMonth(transactions: Transaction[], month: string): Transaction[] {
  return transactions.filter((t) => monthKey(t.timestamp) === month);
}

export function rollupMonth(transactions: Transaction[], month: string): MonthBuckets {
  const buckets: MonthBuckets = { needs: 0, wants: 0, savings: 0, income: 0, month };
  for (const t of transactions) {
    if (t.deletedAt || monthKey(t.timestamp) !== month) continue;
    if (t.excludeFromBudget) continue;
    if (t.categoryGroup === "income") {
      buckets.income += Math.abs(t.amount);
      continue;
    }
    const bucket = spendBucketOf(t.categoryGroup);
    if (bucket) buckets[bucket] += Math.abs(t.amount);
  }
  return buckets;
}

export function recurringItemsForMonth(
  subscriptions: Subscription[],
  monthTxns: Transaction[],
): Record<BudgetBucket, BudgetRecurringItem[]> {
  const items: Record<BudgetBucket, BudgetRecurringItem[]> = { needs: [], wants: [], savings: [] };
  for (const sub of subscriptions) {
    if (sub.status !== "active") continue;
    const bucket = recurringBudgetBucket(sub);
    items[bucket].push({
      id: sub.id,
      name: sub.name,
      kind: recurringKindOf(sub),
      cadence: sub.cadence,
      monthlyAmount: subscriptionMonthlyCost(sub),
      account: sub.account,
      seenThisMonth: monthTxns.some((t) => recurringMatchesTransaction(sub, t)),
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
    needs: items.needs.reduce(
      (sum, item) => sum + (item.seenThisMonth ? 0 : item.monthlyAmount),
      0,
    ),
    wants: items.wants.reduce(
      (sum, item) => sum + (item.seenThisMonth ? 0 : item.monthlyAmount),
      0,
    ),
    savings: items.savings.reduce(
      (sum, item) => sum + (item.seenThisMonth ? 0 : item.monthlyAmount),
      0,
    ),
  };
}

export function recurringAdditionsForMonth(
  subscriptions: Subscription[],
  monthTxns: Transaction[],
): Record<BudgetBucket, number> {
  return recurringAdditionsFromItems(recurringItemsForMonth(subscriptions, monthTxns));
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

export function fallbackFinanceAdvice(args: {
  budget: BudgetLike;
  buckets: MonthBuckets;
  subscriptions: Subscription[];
  netWorth: number;
  profile: UserProfile;
}): FinanceAdviceItem[] {
  const { budget, buckets, subscriptions, netWorth, profile } = args;
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
    items.push({
      category: "subscriptions",
      text: `You're carrying ${active.length} cuttable subscriptions totaling ~$${Math.round(monthlyTotal).toLocaleString()}/mo ($${Math.round(monthlyTotal * 12).toLocaleString()}/yr).${stale.length ? ` ${stale.length} haven't charged in 75+ days — cancel candidates.` : " Cancel any you haven't used this month."}`,
      action: "Audit subscriptions",
    });
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
