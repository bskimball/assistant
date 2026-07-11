import type { FinanceAdviceItem, ISODate, Transaction, UserProfile } from "@/lib/domain";
import {
  cleanMerchantName,
  DEFAULT_BUDGET_TARGETS,
  isCuttableSubscription,
  recurringBudgetBucket,
  recurringKindOf,
  subscriptionMonthlyCost,
} from "@/lib/domain";
import {
  addUnseenRecurringToBuckets,
  fallbackFinanceAdvice,
  monthKey,
  rollupMonth,
} from "@/lib/finance-math";
import { completeJSON, getGrokApiKey, getGrokJsonModel } from "@/server/adapters/ai";
import {
  loadBudgetImpl,
  loadSubscriptionsImpl,
  loadTransactionsImpl,
  loadUserProfileImpl,
} from "@/server/domain-impl";
import { loadFinanceSnapshotForHubImpl } from "@/server/finance-hub-impl";

export const ADVISOR_DISCLAIMER =
  "Educational guidance, not licensed financial advice. This advisor never moves money or executes trades.";

export function profileSummary(profile: UserProfile): string {
  const lines: string[] = [];
  if (profile.displayName) lines.push(`- Name: ${profile.displayName}`);
  if (profile.goals?.length) lines.push(`- Goals: ${profile.goals.join("; ")}`);
  if (profile.skills?.length) lines.push(`- Sellable skills: ${profile.skills.join("; ")}`);
  if (profile.riskTolerance) lines.push(`- Risk tolerance: ${profile.riskTolerance}`);
  if (profile.monthlySavingsGoal)
    lines.push(`- Monthly savings goal: $${profile.monthlySavingsGoal}`);
  if (profile.financeNotes) lines.push(`- Notes: ${profile.financeNotes}`);
  return lines.length ? lines.join("\n") : "- (no finance profile set)";
}

function isPaycheckLike(transaction: Transaction): boolean {
  const text = `${transaction.category || ""} ${transaction.notes || ""}`.toLowerCase();
  return ["payroll", "adp", "direct dep", "salary", "paycheck"].some((keyword) =>
    text.includes(keyword),
  );
}

const USD = (amount: number) => "$" + Math.round(amount).toLocaleString();

function previousMonthKey(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 2, 1)).toISOString().slice(0, 7);
}

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
  for (const account of accounts) {
    const name = account.account || "";
    if (account.amount < 0 || creditRe.test(name)) creditOwed += Math.abs(account.amount);
    else if (investedRe.test(name)) invested += account.amount;
    else cash += account.amount;
  }
  return { cash, invested, creditOwed };
}

export function topMerchantsThisMonth(
  transactions: Transaction[],
  limit: number,
): { name: string; total: number; bucket: string }[] {
  const merchants = new Map<string, { total: number; bucket: string }>();
  for (const transaction of transactions) {
    if (transaction.deletedAt || transaction.amount >= 0) continue;
    if (transaction.categoryGroup === "transfer" || transaction.categoryGroup === "income")
      continue;
    const name = cleanMerchantName(transaction.category || "") || "Unknown";
    const bucket = transaction.categoryGroup ?? "other";
    const current = merchants.get(name) ?? { total: 0, bucket };
    current.total += Math.abs(transaction.amount);
    merchants.set(name, current);
  }
  return [...merchants.entries()]
    .map(([name, value]) => ({
      name,
      total: value.total,
      bucket: value.bucket,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

export interface FinanceAdvicePayload {
  items: FinanceAdviceItem[];
  generatedBy: "ai" | "fallback";
  disclaimer: string;
}

/** Gather finance data, construct the advisor prompt, and preserve the deterministic fallback. */
export async function generateFinanceAdviceImpl(date: ISODate): Promise<FinanceAdvicePayload> {
  const [budget, subsStore, txnStore, snapshotInfo, profile] = await Promise.all([
    loadBudgetImpl(),
    loadSubscriptionsImpl(),
    loadTransactionsImpl(),
    loadFinanceSnapshotForHubImpl(date),
    loadUserProfileImpl(),
  ]);
  const snapshot = snapshotInfo.snapshot;
  const recurring = subsStore.subscriptions.filter((subscription) => !subscription.deletedAt);
  const subscriptions = recurring.filter(
    (subscription) => subscription.status === "active" && isCuttableSubscription(subscription),
  );
  const activeRecurring = recurring.filter((subscription) => subscription.status === "active");
  const transactions = txnStore.transactions.filter((transaction) => !transaction.deletedAt);
  const month = date.slice(0, 7);
  const buckets = rollupMonth(transactions, month);
  const monthTransactions = transactions.filter(
    (transaction) => monthKey(transaction.timestamp) === month,
  );
  addUnseenRecurringToBuckets(buckets, activeRecurring, monthTransactions);
  const netWorth = snapshot.netWorth ?? 0;
  const takeHome = budget?.monthlyTakeHome ?? buckets.income;
  const targets = budget?.targets ?? DEFAULT_BUDGET_TARGETS;
  const sideIncomeMTD = monthTransactions
    .filter(
      (transaction) =>
        transaction.amount > 0 &&
        transaction.categoryGroup === "income" &&
        !isPaycheckLike(transaction),
    )
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const bucketRows = (["needs", "wants", "savings"] as const).map((bucket) => {
    const actual = buckets[bucket];
    const target = takeHome * targets[bucket];
    return { bucket, actual, target, delta: actual - target };
  });
  const topMerchants = topMerchantsThisMonth(monthTransactions, 6);
  const previousMonth = previousMonthKey(month);
  const previousBuckets = rollupMonth(transactions, previousMonth);
  const oneTimeThisMonth = monthTransactions
    .filter((transaction) => transaction.excludeFromBudget && transaction.amount < 0)
    .reduce((sum, transaction) => sum + Math.abs(transaction.amount), 0);
  const loans = activeRecurring.filter((subscription) => recurringKindOf(subscription) === "loan");
  const billsMonthly = activeRecurring
    .filter((subscription) => recurringKindOf(subscription) === "bill")
    .reduce((sum, subscription) => sum + subscriptionMonthlyCost(subscription), 0);
  const recurringSavingsMonthly = activeRecurring
    .filter((subscription) => recurringBudgetBucket(subscription) === "savings")
    .reduce((sum, subscription) => sum + subscriptionMonthlyCost(subscription), 0);
  const monthlySubTotal = subscriptions.reduce(
    (sum, subscription) => sum + subscriptionMonthlyCost(subscription),
    0,
  );
  const positions = (snapshot.positions ?? []).filter((position) => (position.value ?? 0) > 0);
  const holdingsTotal = positions.reduce((sum, position) => sum + (position.value ?? 0), 0);
  const topPositions = [...positions].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 8);
  const topPositionPct =
    holdingsTotal > 0 && topPositions[0] ? (topPositions[0].value / holdingsTotal) * 100 : 0;
  const { cash, invested, creditOwed } = classifyAccountBalances(snapshot.accounts ?? []);
  const monthlyNeedsEstimate = Math.max(buckets.needs, takeHome > 0 ? takeHome * targets.needs : 0);
  const monthsOfNeedsInCash = monthlyNeedsEstimate > 0 ? cash / monthlyNeedsEstimate : 0;
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
  const fallback = fallbackFinanceAdvice({
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
      items: fallback,
      generatedBy: "fallback",
      disclaimer: ADVISOR_DISCLAIMER,
    };

  const formatDelta = (delta: number) =>
    delta >= 0 ? `+${USD(delta)} over` : `${USD(-delta)} under`;
  const loanLines = loans.length
    ? loans
        .map(
          (loan) =>
            `  - ${loan.name}: ${USD(subscriptionMonthlyCost(loan))}/mo${loan.balance ? `, ${USD(loan.balance)} balance` : ""}${loan.apr ? `, ${loan.apr}% APR${loan.apr >= 7 ? " (HIGH — payoff/refi candidate)" : ""}` : ""}`,
        )
        .join("\n")
    : "  - (none tracked)";
  const subscriptionLines = subscriptions.length
    ? subscriptions
        .slice(0, 12)
        .map(
          (subscription) =>
            `  - ${subscription.name}: ${USD(subscriptionMonthlyCost(subscription))}/mo`,
        )
        .join("\n")
    : "  - (none tracked)";
  const merchantLines = topMerchants.length
    ? topMerchants
        .map((merchant) => `  - ${merchant.name}: ${USD(merchant.total)} (${merchant.bucket})`)
        .join("\n")
    : "  - (no spending imported this month)";
  const positionLines = topPositions.length
    ? topPositions
        .map(
          (position) =>
            `  - ${position.symbol}: ${USD(position.value)}${holdingsTotal > 0 ? ` (${Math.round((position.value / holdingsTotal) * 100)}%)` : ""}`,
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
${bucketRows.map((row) => `- ${row.bucket[0].toUpperCase() + row.bucket.slice(1)}: ${USD(row.actual)} spent vs ${USD(row.target)} target (${Math.round(targets[row.bucket] * 100)}%) — ${formatDelta(row.delta)}`).join("\n")}
- Previous month (${previousMonth}) for trend: needs ${USD(previousBuckets.needs)}, wants ${USD(previousBuckets.wants)}, savings ${USD(previousBuckets.savings)}
- One-time / excluded spend this month (ignore for recurring plan): ${USD(oneTimeThisMonth)}
- Top merchants by spend this month:
${merchantLines}

RECURRING COMMITMENTS:
- Loans (individually):
${loanLines}
- Fixed bills total: ${USD(billsMonthly)}/mo
- Cuttable subscriptions: ${subscriptions.length} totaling ${USD(monthlySubTotal)}/mo (${USD(monthlySubTotal * 12)}/yr):
${subscriptionLines}
- Recurring savings/investing contributions: ${USD(recurringSavingsMonthly)}/mo

INVESTMENTS:
- Net worth: ${USD(netWorth)}
- Total holdings value: ${USD(holdingsTotal)}
- Top positions (symbol, value, allocation):
${positionLines}
- Concentration: largest position is ${Math.round(topPositionPct)}% of holdings${topPositionPct >= 25 ? " (concentrated — flag diversification)" : ""}
- Cash/liquidity: ${USD(cash)} cash-like${monthlyNeedsEstimate > 0 ? ` (~${monthsOfNeedsInCash.toFixed(1)} months of needs spend)` : ""}, ${USD(invested)} in named investment accounts, ${USD(creditOwed)} owed on credit/debt accounts

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
- Investing is educational only — allocation, contribution rate, concentration, idle cash vs a 3-6 month emergency fund. Never name a trade to execute. Respect his risk tolerance${profile.riskTolerance ? ` (${profile.riskTolerance})` : ""}.
- Earn: build on his actual sellable skills${profile.skills?.length ? ` (${profile.skills.join(", ")})` : ""} and his side-income history; name ONE measurable experiment with a dollar target.
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
          .map((item: any) => ({
            category: ["budget", "subscriptions", "investing", "earn"].includes(item.category)
              ? item.category
              : "budget",
            text: String(item.text || "").trim(),
            action: item.action ? String(item.action).slice(0, 40) : undefined,
          }))
          .filter((item: FinanceAdviceItem) => item.text)
      : fallback;
    return {
      items: items.length ? items : fallback,
      generatedBy: "ai",
      disclaimer: ADVISOR_DISCLAIMER,
    };
  } catch (error) {
    console.warn("[finance] advisor failed, using fallback", error);
    return {
      items: fallback,
      generatedBy: "fallback",
      disclaimer: ADVISOR_DISCLAIMER,
    };
  }
}
