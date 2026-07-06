/**
 * Shared user-context builder for AI features (ADR-018).
 *
 * Assembles a compact, US-customary-units text snapshot of the member's
 * recorded life — today's dashboard numbers, the trailing 7-day trend, and
 * their long-lived profile — for injection into a system prompt. Reuses the
 * exact loaders and trend math the AI Coach already relies on so the
 * conversational Coach and the one-shot Coach reason over the same source of
 * truth (no duplicated aggregation logic).
 *
 * Runs only inside a server function (scope bound by `auth-middleware`), so the
 * data it reads is always the requesting member's own personal + household
 * scope — never the other member's.
 */

import type { CoachMemory, ISODate } from "@/lib/domain";
import { todayISO, mlToFlOz } from "@/lib/domain";
import {
  loadCoachMemoriesImpl,
  loadDailyDashboardImpl,
  loadUserProfileImpl,
} from "@/server/domain-impl";
import { collectTrend, profileBlock } from "@/server/coach";
import { loadFinanceContextImpl, type FinanceContext } from "@/server/finance";

const memoryCategoryRank: Record<CoachMemory["category"], number> = {
  constraint: 0,
  goal: 1,
  preference: 2,
  life_event: 2,
  milestone: 2,
};

export function memoriesBlock(memories: CoachMemory[]): string {
  return memories
    .filter((m) => !m.deletedAt)
    .sort((a, b) => {
      const rank = memoryCategoryRank[a.category] - memoryCategoryRank[b.category];
      if (rank !== 0) return rank;
      return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);
    })
    .slice(0, 30)
    .map((m) => `- [${m.category}] (id: ${m.id}) ${m.content}`)
    .join("\n");
}

/**
 * Build the user-context block for the chat system prompt. Pure assembly of
 * already-scoped data into prose the model can reason over; degrades
 * gracefully when domains are empty (new user → "not logged yet").
 */
export async function buildUserContextBlock(date: ISODate = todayISO()): Promise<string> {
  const [dash, profile, memoriesStore] = await Promise.all([
    loadDailyDashboardImpl(date),
    loadUserProfileImpl(),
    loadCoachMemoriesImpl(),
  ]);

  const tasks = (dash.productivity?.tasks || []).filter((t) => !t.deletedAt);
  const tasksDone = tasks.filter((t) => t.done).length;
  const proteinTarget = dash.plan?.nutritionTargets?.protein ?? profile.proteinTargetG ?? 150;
  const proteinCurrent = dash.nutrition?.totals?.protein ?? 0;
  const caloriesCurrent = dash.nutrition?.totals?.calories ?? 0;
  const waterOz = mlToFlOz(dash.nutrition?.waterMl ?? 0) ?? 0;
  const mealsLogged = (dash.nutrition?.mealLogs || []).filter((m) => !m.deletedAt).length;

  // Finance comes from the Hub (most-recent net-worth snapshot + this month's
  // transaction rollup), NOT today's daily snapshot — balances aren't logged
  // every day, so keying off "today" would wrongly read as "not set up".
  const [trend, fin] = await Promise.all([
    collectTrend(date, proteinTarget),
    loadFinanceContextImpl(date),
  ]);
  const avgWaterOz = mlToFlOz(trend.avgWaterMl) ?? 0;

  const openTasks = tasks
    .filter((t) => !t.done)
    .slice(0, 8)
    .map((t) => `    - ${t.text}`)
    .join("\n");

  const financeLines = buildFinanceLines(fin, profile.monthlySavingsGoal);
  const remembered = memoriesBlock(memoriesStore.memories);

  return [
    `Member profile:`,
    profileBlock(profile),
    ...(remembered ? [``, `What you remember about the member:`, remembered] : []),
    ``,
    `Today (${date}):`,
    `- Tasks: ${tasksDone}/${tasks.length} complete${openTasks ? `\n  Open tasks:\n${openTasks}` : ""}`,
    `- Nutrition: ${proteinCurrent}g protein of ${proteinTarget}g target, ${caloriesCurrent} kcal, ${mealsLogged} meal(s) logged`,
    `- Hydration: ${waterOz} fl oz`,
    ...financeLines,
    ``,
    `Last ${trend.days} days (trend):`,
    `- Active days: ${trend.activeDays}/${trend.days}`,
    `- Task completion: ${trend.taskCompletionPct}%`,
    `- Workouts: ${trend.workouts}`,
    `- Avg protein: ${trend.avgProteinPct}% of target (direction: ${trend.proteinTrend}); ${trend.proteinDaysOnTarget} day(s) on target`,
    `- Avg water: ${avgWaterOz} fl oz`,
    `- Net-worth change: ${trend.netWorthChange >= 0 ? "+" : ""}$${trend.netWorthChange.toLocaleString()}`,
    `- Net cashflow (logged): ${trend.netCashflow >= 0 ? "+" : ""}$${trend.netCashflow.toLocaleString()}`,
  ].join("\n");
}

const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;

/** Render the finance section: net worth (most-recent snapshot), this month's
 *  income/savings, savings-goal progress, and subscription load. */
function buildFinanceLines(fin: FinanceContext, savingsGoal?: number): string[] {
  if (!fin.hasFinance) return ["- Finance: not set up yet"];

  const lines = [
    `- Finance — net worth ${usd(fin.netWorth)} (as of ${fin.netWorthAsOf})`,
    `  This month: income ${usd(fin.thisMonth.income)}, saved ${usd(fin.thisMonth.savings)}, needs ${usd(fin.thisMonth.needs)}, wants ${usd(fin.thisMonth.wants)}`,
  ];
  if (savingsGoal && savingsGoal > 0) {
    const saved = fin.thisMonth.savings;
    const gap = savingsGoal - saved;
    lines.push(
      `  Savings goal: ${usd(saved)} of ${usd(savingsGoal)} this month — ${
        gap <= 0 ? "on track ✓" : `${usd(gap)} to go`
      }`,
    );
  }
  if (fin.activeSubscriptionCount > 0) {
    lines.push(
      `  Subscriptions: ~${usd(fin.monthlySubscriptionCost)}/mo across ${fin.activeSubscriptionCount} active`,
    );
  }
  return lines;
}
