import { fmtMoney } from "@/components/finance/shared";
import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Reveal, revealDelay } from "@/components/motion";
import { financeAdviceQuery, queryKeys } from "@/lib/queries";
import {
  ArrowsClockwiseIcon,
  BriefcaseIcon,
  CalendarCheckIcon,
  ChartLineIcon,
  CheckCircleIcon,
  CheckIcon,
  CurrencyCircleDollarIcon,
  LightbulbIcon,
  PiggyBankIcon,
  RepeatIcon,
  SparkleIcon,
  TargetIcon,
  TrendUpIcon,
} from "@phosphor-icons/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { acceptFinanceActions } from "@/server/finance";
import type { FinanceHubPayload } from "@/lib/finance-types";
import {
  spendAmountOf,
  spendBucketOf,
  DEFAULT_BUDGET_TARGETS,
  type FinanceAdviceItem,
} from "@/lib/domain";
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
  { label: string; Icon: typeof LightbulbIcon }
> = {
  budget: { label: "Budget", Icon: PiggyBankIcon },
  subscriptions: { label: "Subscriptions", Icon: RepeatIcon },
  investing: { label: "Investing", Icon: TrendUpIcon },
  earn: { label: "Earn more", Icon: CurrencyCircleDollarIcon },
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

      <div className="zen-card flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-pretty text-sm text-muted-foreground">
          Personalized budget fixes, a subscription audit, and investing moves — grounded in your
          real numbers.
        </p>
        <Button
          onClick={generate}
          disabled={busy}
          className="shrink-0 gap-1.5 transition-[scale,background-color,color,box-shadow] active:scale-[0.96]"
        >
          {busy ? (
            <ArrowsClockwiseIcon className="size-4 animate-spin" />
          ) : (
            <SparkleIcon className="size-4" weight="duotone" />
          )}
          {items ? "Regenerate advice" : "Generate advice"}
        </Button>
      </div>

      <CollapsibleCard
        id="grow-advice"
        title="Recommended moves"
        icon={SparkleIcon}
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
                          <meta.Icon className="size-4" weight="duotone" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[11px] font-medium text-muted-foreground">
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
                        <CheckIcon className="size-3.5" weight="duotone" />
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
                <CheckIcon className="size-4" weight="duotone" />{" "}
                {allAccepted ? "Added to tasks" : "Add all to tasks"}
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
                <ArrowsClockwiseIcon className="size-4 animate-spin" />
              ) : (
                <SparkleIcon className="size-4" weight="duotone" />
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
    if (bucket) buckets[bucket] += spendAmountOf(t);
  }
  const recurring = recurringAdditionsForMonth(hub.subscriptions, monthTxns, startMonth);
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
      ? "text-info"
      : projection.totalNetCashFlow < 0
        ? "text-destructive"
        : "text-muted-foreground";

  return (
    <Card className="border-info/20 bg-linear-to-br from-info/6 to-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ChartLineIcon className="size-4 text-info" weight="duotone" />
          12-month cash-flow projection
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="zen-surface-nested flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-xs font-medium text-muted-foreground">Projected ending cash</div>
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
        <div className="zen-surface-nested px-3 py-2">
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
              <div key={month.month} className="zen-surface-nested px-2 py-2">
                <div className="text-[10px] text-muted-foreground">
                  {formatMonthLabel(month.month).slice(0, 3)}
                </div>
                <div
                  className={`mt-1 text-sm font-semibold tabular-nums ${
                    month.netCashFlow >= 0 ? "text-info" : "text-destructive"
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
    .reduce((s, t) => s + spendAmountOf(t), 0);
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
      Icon: BriefcaseIcon,
    },
    {
      label: "Consulting offer",
      text: "Package one specific skill into a paid audit, automation, or advisory session.",
      Icon: CurrencyCircleDollarIcon,
    },
    {
      label: "Weekly pipeline",
      text: "Send five warm outreach messages and log every reply as a tracked opportunity.",
      Icon: CalendarCheckIcon,
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
      icon={TargetIcon}
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
              className={`flex min-h-10 gap-3 rounded-lg border px-3 py-2 text-left transition-[scale,background-color,color,box-shadow] active:scale-[0.96] ${
                completedLevers.has(label)
                  ? "border-success/30 bg-success/10"
                  : "border-border/60 bg-muted/20 hover:bg-muted/40"
              }`}
            >
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
                {completedLevers.has(label) ? (
                  <CheckCircleIcon className="size-4 text-success" weight="duotone" />
                ) : (
                  <Icon className="size-4 text-info" weight="duotone" />
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
