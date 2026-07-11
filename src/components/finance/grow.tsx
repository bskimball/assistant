import { fmtMoney } from "@/components/finance/shared";
import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Reveal, revealDelay } from "@/components/motion";
import { financeAdviceQuery, queryKeys } from "@/lib/queries";
import {
  PiggyBank,
  Repeat,
  TrendingUp,
  Lightbulb,
  RefreshCw,
  Check,
  CircleDollarSign,
  Sparkles,
  Target,
  BriefcaseBusiness,
  CalendarCheck,
  LineChart,
  CheckCircle2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { acceptFinanceActions, type FinanceHubPayload } from "@/server/finance";
import { spendBucketOf, DEFAULT_BUDGET_TARGETS, type FinanceAdviceItem } from "@/lib/domain";
import {
  buildCashFlowProjection,
  recurringAdditionsForMonth,
  transactionsForMonth,
  type BudgetBucket,
} from "@/lib/finance-math";
import {
  CollapsibleCard,
  InfoHint,
  MiniStat,
  cashLikeBalance,
  formatMonthLabel,
  isPaycheckLike,
} from "@/components/finance/shared";

const ADVICE_META: Record<
  FinanceAdviceItem["category"],
  { label: string; Icon: typeof Lightbulb }
> = {
  budget: { label: "Budget", Icon: PiggyBank },
  subscriptions: { label: "Subscriptions", Icon: Repeat },
  investing: { label: "Investing", Icon: TrendingUp },
  earn: { label: "Earn more", Icon: CircleDollarSign },
};

const FINANCE_HIGHLIGHT_RE = /(\$[\d,]+(?:\.\d+)?|\d+(?:\.\d+)?%?)/;

type FinanceAdviceResult = {
  items: FinanceAdviceItem[];
  generatedBy: "ai" | "fallback";
};

function renderHighlightedAdvice(text: string) {
  return text.split(FINANCE_HIGHLIGHT_RE).map((part, index) =>
    FINANCE_HIGHLIGHT_RE.test(part) ? (
      <strong key={`${part}-${index}`} className="font-semibold text-foreground">
        {part}
      </strong>
    ) : (
      part
    ),
  );
}

export function GrowTab({
  hub,
  today,
  flash,
}: {
  hub: FinanceHubPayload;
  today: string;
  flash: (m: string) => void;
}) {
  const queryClient = useQueryClient();
  const cachedAdvice = queryClient.getQueryData<FinanceAdviceResult>(
    queryKeys.financeAdvice(today),
  );
  const adviceQuery = useQuery(financeAdviceQuery(today));
  const [items, setItems] = useState<FinanceAdviceItem[] | null>(
    () => cachedAdvice?.items ?? adviceQuery.data?.items ?? null,
  );
  const [generatedBy, setGeneratedBy] = useState<"ai" | "fallback" | null>(
    () => cachedAdvice?.generatedBy ?? adviceQuery.data?.generatedBy ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [acceptedItems, setAcceptedItems] = useState<Set<number>>(new Set());
  const allAccepted = !!items?.length && acceptedItems.size >= items.length;
  const adviceSummary = items?.length
    ? items.length === 1
      ? items[0]?.text
      : `${items.length} moves · ${items[0]?.text}`
    : "Generate personalized moves";

  useEffect(() => {
    if (!items && adviceQuery.data) {
      setItems(adviceQuery.data.items);
      setGeneratedBy(adviceQuery.data.generatedBy);
    }
  }, [adviceQuery.data, items]);

  async function generate() {
    setBusy(true);
    setAcceptedItems(new Set());
    try {
      const res = await adviceQuery.refetch();
      if (!res.data) throw res.error ?? new Error("No finance advice returned.");
      setItems(res.data.items);
      setGeneratedBy(res.data.generatedBy);
    } catch (e) {
      console.error(e);
      flash("Couldn’t generate advice.");
    } finally {
      setBusy(false);
    }
  }

  async function acceptAll() {
    if (!items?.length) return;
    setBusy(true);
    try {
      await acceptFinanceActions({ data: { date: today, items } });
      setAcceptedItems(new Set(items.map((_, index) => index)));
      flash("Added to today’s tasks.");
    } finally {
      setBusy(false);
    }
  }

  async function acceptOne(item: FinanceAdviceItem, index: number) {
    setBusy(true);
    try {
      await acceptFinanceActions({ data: { date: today, items: [item] } });
      setAcceptedItems((prev) => new Set(prev).add(index));
      flash("Added to today’s tasks.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <CashFlowProjectionCard hub={hub} today={today} />
      <RevenueGrowthCard hub={hub} today={today} />

      <div className="flex flex-col gap-3 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-pretty text-sm text-muted-foreground">
          Personalized budget fixes, a subscription audit, and investing moves — grounded in your
          real numbers.
        </p>
        <Button
          onClick={generate}
          disabled={busy}
          className="shrink-0 gap-1.5 transition-[scale,background-color,color,box-shadow] active:scale-[0.96]"
        >
          {busy ? <RefreshCw className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          {items ? "Regenerate advice" : "Generate advice"}
        </Button>
      </div>

      <CollapsibleCard
        id="grow-advice"
        title="Recommended moves"
        icon={Sparkles}
        summary={adviceSummary}
        badge={items?.length ?? 0}
        defaultOpen={false}
        forceOpen={!!items?.length}
      >
        {items?.length ? (
          <div className="space-y-3">
            <div className="divide-y divide-border/60">
              {items.map((it, i) => {
                const meta = ADVICE_META[it.category];
                const accepted = acceptedItems.has(i);
                return (
                  <Reveal as="div" key={`${it.category}-${i}`} delay={revealDelay(i)}>
                    <div className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex min-w-0 gap-3">
                        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <meta.Icon className="size-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            {meta.label}
                          </div>
                          <div className="text-pretty text-sm leading-6">
                            {renderHighlightedAdvice(it.text)}
                          </div>
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant={accepted ? "secondary" : "outline"}
                        onClick={() => acceptOne(it, i)}
                        disabled={busy || accepted}
                        className="shrink-0 gap-1.5 transition-[scale,background-color,color,box-shadow] active:scale-[0.96]"
                      >
                        <Check className="size-3.5" />
                        {accepted ? "Added" : "Add to tasks"}
                      </Button>
                    </div>
                  </Reveal>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={acceptAll}
                disabled={busy || allAccepted}
                variant="outline"
                className="gap-1.5 transition-[scale,background-color,color,box-shadow] active:scale-[0.96]"
              >
                <Check className="size-4" /> {allAccepted ? "Added to tasks" : "Add all to tasks"}
              </Button>
              {generatedBy === "fallback" && (
                <span className="text-xs text-muted-foreground">
                  Rule-based (no AI key) — still grounded in your data.
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              Generate moves when you want the coach to turn your budget, recurring charges, and
              investments into tasks.
            </p>
            <Button
              onClick={generate}
              disabled={busy}
              variant="outline"
              className="shrink-0 gap-1.5 transition-[scale,background-color,color,box-shadow] active:scale-[0.96]"
            >
              {busy ? (
                <RefreshCw className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              Generate advice
            </Button>
          </div>
        )}
      </CollapsibleCard>

      <p className="text-xs text-muted-foreground">
        Educational guidance only. This app never moves money or executes trades.
      </p>
    </div>
  );
}

function CashFlowProjectionCard({ hub, today }: { hub: FinanceHubPayload; today: string }) {
  const startMonth = today.slice(0, 7);
  const accounts = hub.snapshot.accounts || [];
  const cashOnHand = cashLikeBalance(accounts);
  const monthTxns = transactionsForMonth(hub.transactions, startMonth);
  const targets = hub.budget?.targets ?? DEFAULT_BUDGET_TARGETS;
  const takeHome =
    hub.budget?.monthlyTakeHome ??
    monthTxns
      .filter((t) => t.amount > 0 && t.categoryGroup === "income")
      .reduce((sum, t) => sum + t.amount, 0);
  const buckets: Record<BudgetBucket, number> = {
    needs: 0,
    wants: 0,
    savings: 0,
  };
  for (const t of monthTxns) {
    if (t.excludeFromBudget) continue;
    const bucket = spendBucketOf(t.categoryGroup);
    if (bucket) buckets[bucket] += Math.abs(t.amount);
  }
  const recurring = recurringAdditionsForMonth(hub.subscriptions, monthTxns);
  const monthlyBuckets =
    takeHome > 0
      ? {
          needs: Math.max(buckets.needs + recurring.needs, takeHome * targets.needs),
          wants: Math.max(buckets.wants + recurring.wants, takeHome * targets.wants),
          savings: Math.max(buckets.savings + recurring.savings, takeHome * targets.savings),
        }
      : {
          needs: buckets.needs + recurring.needs,
          wants: buckets.wants + recurring.wants,
          savings: buckets.savings + recurring.savings,
        };
  const projection = buildCashFlowProjection({
    startMonth,
    months: 12,
    transactions: hub.transactions,
    subscriptions: hub.subscriptions,
    startingCash: cashOnHand,
    monthlyIncome: takeHome,
    monthlyBuckets,
    includeRecurringCommitments: false,
  });
  const averageNet = projection.months.length
    ? projection.totalNetCashFlow / projection.months.length
    : 0;
  const lowPoint = projection.months.reduce(
    (lowest, month) => Math.min(lowest, month.endingCash),
    cashOnHand,
  );
  const nextMonths = projection.months.slice(0, 4);
  const netTone =
    projection.totalNetCashFlow > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : projection.totalNetCashFlow < 0
        ? "text-destructive"
        : "text-muted-foreground";

  return (
    <Card className="border-sky-500/20 bg-linear-to-br from-sky-500/6 to-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <LineChart className="size-4 text-sky-600 dark:text-sky-400" />
          12-month cash-flow projection
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-3 rounded-lg bg-background/55 px-3 py-3 ring-1 ring-foreground/10 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Projected ending cash
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums sm:text-3xl">
              {fmtMoney(projection.endingCash)}
            </div>
          </div>
          <div className={`text-sm font-medium tabular-nums ${netTone}`}>
            {projection.totalNetCashFlow < 0 ? "-" : "+"}
            {fmtMoney(Math.abs(projection.totalNetCashFlow))} projected net
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <MiniStat label="Starting cash" value={fmtMoney(cashOnHand)} />
          <MiniStat label="Lowest projected cash" value={fmtMoney(lowPoint)} />
        </div>
        <div className="rounded-lg bg-muted/25 px-3 py-2 ring-1 ring-foreground/10">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              Average monthly net{" "}
              <span className={`font-medium tabular-nums ${netTone}`}>
                {averageNet < 0 ? "-" : "+"}
                {fmtMoney(Math.abs(averageNet))}
              </span>
            </span>
            <span className="tabular-nums">Lowest projected cash {fmtMoney(lowPoint)}</span>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-4">
            {nextMonths.map((month) => (
              <div key={month.month} className="rounded-md bg-background/50 px-2 py-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {formatMonthLabel(month.month).slice(0, 3)}
                </div>
                <div
                  className={`mt-1 text-sm font-semibold tabular-nums ${
                    month.netCashFlow >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-destructive"
                  }`}
                >
                  {month.netCashFlow < 0 ? "-" : "+"}
                  {fmtMoney(Math.abs(month.netCashFlow))}
                </div>
                <div className="text-[11px] tabular-nums text-muted-foreground">
                  End {fmtMoney(month.endingCash)}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span>
            Projection uses take-home, budget targets, current run-rate, and recurring commitments.
          </span>
          <InfoHint label="Projection assumptions">
            Projection uses the current take-home baseline when set, the higher of budget targets or
            current run-rate buckets, and active recurring commitments already folded into those
            buckets.
          </InfoHint>
        </div>
      </CardContent>
    </Card>
  );
}

function RevenueGrowthCard({ hub, today }: { hub: FinanceHubPayload; today: string }) {
  const [completedLevers, setCompletedLevers] = useState<Set<string>>(new Set());
  const month = today.slice(0, 7);
  const monthTxns = transactionsForMonth(hub.transactions, month);
  const takeHome =
    hub.budget?.monthlyTakeHome ??
    monthTxns
      .filter((t) => t.amount > 0 && t.categoryGroup === "income")
      .reduce((s, t) => s + t.amount, 0);
  const targets = hub.budget?.targets ?? DEFAULT_BUDGET_TARGETS;
  const savings = monthTxns
    .filter((t) => spendBucketOf(t.categoryGroup) === "savings" && !t.excludeFromBudget)
    .reduce((s, t) => s + Math.abs(t.amount), 0);
  const sideIncome = monthTxns
    .filter((t) => t.amount > 0 && t.categoryGroup === "income" && !isPaycheckLike(t))
    .reduce((s, t) => s + t.amount, 0);
  const savingsTarget = takeHome * targets.savings;
  const revenueGap = Math.max(0, savingsTarget - savings);
  const experimentTarget =
    revenueGap > 0 ? revenueGap : takeHome > 0 ? Math.max(250, takeHome * 0.05) : 250;
  const levers = [
    {
      label: "Primary income",
      text: "Pick one raise, bonus, promotion, or client-rate conversation and prepare the dollar case.",
      Icon: BriefcaseBusiness,
    },
    {
      label: "Consulting offer",
      text: "Package one specific skill into a paid audit, automation, or advisory session.",
      Icon: CircleDollarSign,
    },
    {
      label: "Weekly pipeline",
      text: "Send five warm outreach messages and log every reply as a tracked opportunity.",
      Icon: CalendarCheck,
    },
  ];

  function toggleLever(label: string) {
    setCompletedLevers((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  return (
    <CollapsibleCard
      id="grow-revenue-growth"
      title="Revenue growth target"
      icon={Target}
      summary={`Side income ${fmtMoney(sideIncome)} · target ${fmtMoney(experimentTarget)}`}
      defaultOpen={false}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <MiniStat label="Take-home baseline" value={takeHome ? fmtMoney(takeHome) : "Missing"} />
          <MiniStat label="Side income MTD" value={fmtMoney(sideIncome)} />
          <MiniStat label="Target experiment" value={`${fmtMoney(experimentTarget)}/mo`} />
        </div>
        <div className="grid gap-2">
          {levers.map(({ label, text, Icon }) => (
            <button
              key={label}
              type="button"
              onClick={() => toggleLever(label)}
              aria-pressed={completedLevers.has(label)}
              className={`flex min-h-10 gap-3 rounded-lg px-3 py-2 text-left ring-1 ring-foreground/10 transition-[scale,background-color,color,box-shadow] active:scale-[0.96] ${
                completedLevers.has(label) ? "bg-emerald-500/10" : "bg-muted/20 hover:bg-muted/40"
              }`}
            >
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
                {completedLevers.has(label) ? (
                  <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Icon className="size-4 text-primary" />
                )}
              </span>
              <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-pretty text-xs text-muted-foreground">{text}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span>
            Target follows the savings gap, or starts with a small monthly income experiment.
          </span>
          <InfoHint label="Revenue target details">
            The target is based on the current savings gap when available; otherwise it starts with
            a small monthly income experiment so the plan has a number to beat.
          </InfoHint>
        </div>
      </div>
    </CollapsibleCard>
  );
}

// A small labeled figure. Non-interactive by default (renders a <div>); pass
// `onClick` to make it a real button that opens a breakdown dialog — the visual
// layout stays identical so mixed rows stay aligned. Other call sites in this
