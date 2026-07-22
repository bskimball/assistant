import type { FinanceAdviceItem, Subscription, UserProfile } from "@/lib/domain";
import { DEFAULT_BUDGET_TARGETS, subscriptionMonthlyCost } from "@/lib/domain";
import type { BudgetBucket, BudgetLike, MonthBuckets } from "./_shared";
import { DAY } from "./_shared";

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
