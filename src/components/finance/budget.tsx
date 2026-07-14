import { GroupPicker, MonthNav } from "@/components/finance/shared";
import { fmtMoney } from "@/components/finance/shared";
import type { FinanceTabProps } from "@/components/finance/shared";
import { useState, useRef, useEffect } from "react";
import { Upload, RefreshCw, Check, Pencil, ListChecks, Receipt } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  saveBudget,
  importTransactions,
  recategorizeTransaction,
  recategorizeAllTransactions,
  setTransactionExcluded,
  dismissOneTimeSuggestion,
} from "@/server/finance";
import {
  spendAmountOf,
  spendBucketOf,
  cleanMerchantName,
  DEFAULT_BUDGET_TARGETS,
  type CategoryGroup,
  type Transaction,
} from "@/lib/domain";
import {
  buildBudgetInsight,
  detectOneTimeCandidates,
  recurringAdditionsFromItems,
  recurringItemsForMonth,
  transactionsBeforeMonth,
  transactionsForMonth,
  type BudgetBucket,
  type BudgetRecurringItem,
  type OneTimeCandidate,
} from "@/lib/finance-math";
import {
  BudgetBar,
  CADENCE_ABBR,
  CollapsibleCard,
  GROUP_LABELS,
  InfoHint,
  MiniStat,
  TxnSubline,
  fmtDate,
  formatMonthLabel,
  moneyInputValue,
  recurringAdditionsSummary,
  recurringKindLabel,
  shiftMonth,
} from "@/components/finance/shared";

const INSTITUTIONS = ["Bank of America", "M&T Bank", "Capital One", "Robinhood", "Other"];

export function BudgetTab({ hub, month, onChange, flash }: FinanceTabProps & { month: string }) {
  const [takeHome, setTakeHome] = useState(moneyInputValue(hub.budget?.monthlyTakeHome));
  const [cadence, setCadence] = useState<
    "monthly" | "semimonthly" | "biweekly" | "weekly" | "none"
  >(hub.budget?.paySchedule?.cadence ?? "none");
  const [anchorDate, setAnchorDate] = useState(hub.budget?.paySchedule?.anchorDate ?? "");
  const [payDaysRaw, setPayDaysRaw] = useState(hub.budget?.paySchedule?.payDays?.join(", ") ?? "");
  const [busy, setBusy] = useState(false);
  const [showAllInsightLines, setShowAllInsightLines] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [institution, setInstitution] = useState(INSTITUTIONS[0]);

  useEffect(() => {
    setTakeHome(moneyInputValue(hub.budget?.monthlyTakeHome));
    setCadence(hub.budget?.paySchedule?.cadence ?? "none");
    setAnchorDate(hub.budget?.paySchedule?.anchorDate ?? "");
    setPayDaysRaw(hub.budget?.paySchedule?.payDays?.join(", ") ?? "");
  }, [hub.budget]);

  // Which month the plan + expense sorter show. Defaults to the current month;
  // the arrows in the header let the user step back to months that actually have
  // imported statements. Next is capped at the current month (no future).
  const [selectedMonth, setSelectedMonth] = useState(month);
  const isCurrentMonth = selectedMonth === month;
  // Snappy drag/tap re-bucketing: a moved transaction jumps buckets immediately
  // via this override, then the override is dropped once the refetched hub agrees
  // (or reverted on failure).
  const [moveOverrides, setMoveOverrides] = useState<Record<string, "needs" | "wants" | "savings">>(
    {},
  );
  // Which hero tile's transaction breakdown is open (null = none).
  const [breakdown, setBreakdown] = useState<null | "spent" | "onetime" | "recurring">(null);

  const targets = hub.budget?.targets ?? DEFAULT_BUDGET_TARGETS;
  const th = Number(takeHome) || hub.budget?.monthlyTakeHome || 0;

  const monthTxns = transactionsForMonth(hub.transactions, selectedMonth);
  // Per-bucket totals + the transactions behind each bar. One-time charges the
  // user has marked (excludeFromBudget) are kept in the lists and tracked as real
  // money, but left out of plan totals so a single big bill doesn't blow the
  // monthly 50/30/20 comparison.
  const buckets: Record<BudgetBucket, number> = {
    needs: 0,
    wants: 0,
    savings: 0,
  };
  const bucketTxns: Record<BudgetBucket, Transaction[]> = {
    needs: [],
    wants: [],
    savings: [],
  };
  for (const t of monthTxns) {
    const b = moveOverrides[t.id] ?? spendBucketOf(t.categoryGroup);
    if (!b) continue;
    bucketTxns[b].push(t);
    if (!t.excludeFromBudget) buckets[b] += spendAmountOf(t);
  }
  for (const b of ["needs", "wants", "savings"] as const) {
    bucketTxns[b].sort((a, c) => Math.abs(c.amount) - Math.abs(a.amount));
  }
  async function toggleExclude(id: string, excluded: boolean) {
    await setTransactionExcluded({ data: { id, excluded } });
    await onChange();
    flash(excluded ? "Marked as one-time — left out of the plan." : "Back in the plan.");
  }

  async function dismissOneTime(id: string) {
    await dismissOneTimeSuggestion({ data: { id } });
    await onChange();
    flash("Suggestion dismissed.");
  }

  // Drag/tap an expense into a different 50/30/20 bucket. Optimistic: the card
  // moves at once, we persist + refetch, then clear the override (on error we
  // drop it so the card snaps back to where it really is).
  async function moveToBucket(id: string, group: BudgetBucket) {
    const current = monthTxns.find((t) => t.id === id);
    const effective = current && (moveOverrides[id] ?? spendBucketOf(current.categoryGroup));
    if (effective === group) return;
    setMoveOverrides((o) => ({ ...o, [id]: group }));
    try {
      await recategorizeTransaction({ data: { id, group } });
      await onChange();
      flash(`Moved to ${GROUP_LABELS[group]}.`);
    } catch (err) {
      console.error(err);
      flash("Couldn’t move that expense.");
    } finally {
      setMoveOverrides((o) => {
        const next = { ...o };
        delete next[id];
        return next;
      });
    }
  }

  // Recurring commitments are normalized into the same 50/30/20 buckets as
  // imported transactions. Show the full monthly plan every month, but only add
  // rows that are not already represented by imported statement data.
  const recurringItems = recurringItemsForMonth(
    hub.subscriptions,
    monthTxns,
    transactionsBeforeMonth(hub.transactions, selectedMonth),
    selectedMonth,
  );
  const recurringAdditions = recurringAdditionsFromItems(recurringItems);
  for (const b of ["needs", "wants", "savings"] as const) {
    buckets[b] += recurringAdditions[b];
  }
  const plannedRecurring =
    recurringAdditions.needs + recurringAdditions.wants + recurringAdditions.savings;
  const budgetInsight = buildBudgetInsight({
    transactions: hub.transactions,
    subscriptions: hub.subscriptions,
    month: selectedMonth,
    takeHome: th,
    targets,
  });
  const oneTimeCandidates = isCurrentMonth
    ? detectOneTimeCandidates({
        transactions: hub.transactions,
        subscriptions: hub.subscriptions,
        month: selectedMonth,
        monthlyTakeHome: th,
      })
    : [];

  // Itemized breakdowns behind the three hero tiles. Totals stay authoritative
  // via `budgetInsight.*`; these lists are the transactions/commitments that add
  // up to those numbers. Grouped by 50/30/20 bucket to reinforce the plan.
  const bucketOrder = ["needs", "wants", "savings"] as const;
  const spentGroups = bucketOrder
    .map((b) => {
      const txns = bucketTxns[b].filter((t) => !t.excludeFromBudget);
      return {
        key: b,
        label: GROUP_LABELS[b],
        subtotal: txns.reduce((s, t) => s + spendAmountOf(t), 0),
        txns,
      };
    })
    .filter((g) => g.txns.length > 0);
  const oneTimeTxns = monthTxns
    .filter((t) => t.amount < 0 && t.excludeFromBudget && spendBucketOf(t.categoryGroup))
    .sort((a, c) => Math.abs(c.amount) - Math.abs(a.amount));
  const recurringGroups = bucketOrder
    .map((b) => {
      const items = recurringItems[b]
        .filter((i) => i.remainingMonthlyAmount > 0)
        .sort((a, c) => c.remainingMonthlyAmount - a.remainingMonthlyAmount);
      return {
        key: b,
        label: GROUP_LABELS[b],
        subtotal: items.reduce((s, i) => s + i.remainingMonthlyAmount, 0),
        items,
      };
    })
    .filter((g) => g.items.length > 0);

  async function saveBudgetSettings() {
    const v = Number(takeHome);
    if (!Number.isFinite(v) || v <= 0) return;
    setBusy(true);
    try {
      const payDays = payDaysRaw
        ? payDaysRaw
            .split(",")
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => Number.isInteger(n) && n >= 1 && n <= 31)
        : undefined;

      await saveBudget({
        data: {
          budget: {
            monthlyTakeHome: v,
            targets: hub.budget?.targets ?? { ...DEFAULT_BUDGET_TARGETS },
            categoryLimits: hub.budget?.categoryLimits,
            paySchedule:
              cadence === "none"
                ? undefined
                : {
                    cadence,
                    anchorDate: anchorDate || undefined,
                    payDays: payDays && payDays.length > 0 ? payDays : undefined,
                  },
          },
        },
      });
      await onChange();
      flash("Budget settings saved.");
    } catch (err) {
      console.error(err);
      flash("Failed to save budget settings.");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    flash("Importing…");
    try {
      const csv = await file.text();
      const res = await importTransactions({
        data: { csv, institution, account: institution },
      });
      await onChange();
      flash(
        `Imported ${res.added} new transactions (${res.skipped} duplicates skipped` +
          (res.invalidDates ? `, ${res.invalidDates} rows dropped for unreadable dates` : "") +
          `).`,
      );
    } catch (err) {
      console.error(err);
      flash("Import failed — is it a CSV statement export?");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function recategorizeAll() {
    setBusy(true);
    flash("Re-categorizing…");
    try {
      const res = await recategorizeAllTransactions({ data: {} });
      await onChange();
      flash(`Re-categorized ${res.changed} of ${res.total} transactions.`);
    } catch (err) {
      console.error(err);
      flash("Couldn’t re-categorize transactions.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-col gap-3 text-base sm:flex-row sm:items-start sm:justify-between">
            <span className="min-w-0">
              <span className="block text-balance">
                {isCurrentMonth ? "This month vs plan" : "Month vs plan"}
              </span>
              <span className="mt-1 block text-xs font-normal text-muted-foreground">
                of{" "}
                <span className="font-medium tabular-nums text-foreground">
                  {th > 0 ? fmtMoney(th) : "unset"}
                </span>{" "}
                take-home
              </span>
            </span>
            <div className="flex flex-col gap-2 sm:items-end">
              <MonthNav
                month={selectedMonth}
                onPrev={() => setSelectedMonth((m) => shiftMonth(m, -1))}
                onNext={() => setSelectedMonth((m) => shiftMonth(m, 1))}
                canGoNext={!isCurrentMonth}
              />
              {th > 0 ? (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="gap-1.5">
                      <Pencil className="size-3.5" /> Edit budget settings
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-80">
                    <BudgetSettingsEditor
                      monthlyTakeHome={takeHome}
                      setMonthlyTakeHome={setTakeHome}
                      cadence={cadence}
                      setCadence={setCadence}
                      anchorDate={anchorDate}
                      setAnchorDate={setAnchorDate}
                      payDaysRaw={payDaysRaw}
                      setPayDaysRaw={setPayDaysRaw}
                      onSave={saveBudgetSettings}
                      busy={busy}
                    />
                  </PopoverContent>
                </Popover>
              ) : (
                <div className="flex items-center gap-2 rounded-lg bg-muted/40 p-1 ring-1 ring-foreground/10">
                  <Label htmlFor="th" className="sr-only">
                    After-tax pay per month
                  </Label>
                  <Input
                    id="th"
                    type="number"
                    step="0.01"
                    value={takeHome}
                    onChange={(e) => setTakeHome(e.target.value)}
                    placeholder="Take-home"
                    className="h-8 w-32 border-0 bg-background text-sm tabular-nums shadow-sm"
                    disabled={busy}
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={saveBudgetSettings}
                    disabled={busy || !takeHome}
                    className="gap-1 transition-[scale,background-color,color,box-shadow] active:scale-[0.96]"
                  >
                    <Check className="size-3.5" /> Save
                  </Button>
                </div>
              )}
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="-mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <span>Imported + synced spend for {formatMonthLabel(selectedMonth)}.</span>
            <InfoHint>
              Spending here comes from your imported and synced transactions, plus active recurring
              commitments from the Recurring tab that haven’t shown up in statements yet. “Left
              before upcoming bills” subtracts posted plan spending and one-time spending. “Left
              before savings target” also subtracts upcoming recurring commitments, but it does not
              reserve the unmet savings target. The Overview guardrail shows that final reserve
              separately. Targets are 50/30/20 of the take-home baseline in this header.
            </InfoHint>
          </div>
          {th > 0 ? (
            <>
              {/* Hero: the two numbers that matter, with three secondary tiles. */}
              <div className="rounded-lg bg-muted/20 p-3 ring-1 ring-foreground/10">
                <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                  <div>
                    <div className="text-xs font-medium text-muted-foreground">
                      Left before upcoming bills
                    </div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums sm:text-3xl">
                      {fmtMoney(budgetInsight.remainingCash)}
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      Includes one-time spending
                    </div>
                  </div>
                  <div className="border-l border-border/60 pl-6">
                    <div className="text-xs font-medium text-muted-foreground">
                      Left before savings target
                    </div>
                    <div className="mt-1 text-xl font-semibold tabular-nums text-muted-foreground sm:text-2xl">
                      {fmtMoney(budgetInsight.remainingAfterCommitted)}
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      After upcoming recurring and one-time spending
                    </div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <MiniStat
                    label="Spent so far"
                    value={fmtMoney(budgetInsight.planSpend)}
                    onClick={spentGroups.length > 0 ? () => setBreakdown("spent") : undefined}
                  />
                  <MiniStat
                    label="One-time"
                    value={`${fmtMoney(budgetInsight.oneTimeSpend)} · ${budgetInsight.oneTimeCount}`}
                    onClick={oneTimeTxns.length > 0 ? () => setBreakdown("onetime") : undefined}
                  />
                  <MiniStat
                    label="Upcoming recurring"
                    value={fmtMoney(budgetInsight.plannedRecurring)}
                    onClick={
                      recurringGroups.length > 0 ? () => setBreakdown("recurring") : undefined
                    }
                  />
                </div>
              </div>

              {/* The story: 50/30/20 immediately under the hero. */}
              <div className="space-y-3">
                {(["needs", "wants", "savings"] as const).map((b) => (
                  <BudgetBar
                    key={b}
                    label={b}
                    actual={buckets[b]}
                    recurringPlanned={recurringAdditions[b]}
                    target={th * targets[b]}
                    targetPct={Math.round(targets[b] * 100)}
                    goal={b === "savings" ? "save" : "spend"}
                    txns={bucketTxns[b]}
                    recurringItems={recurringItems[b]}
                    onToggleExclude={toggleExclude}
                  />
                ))}
              </div>

              {/* Insight: first line, expand for the rest. */}
              {budgetInsight.lines.length > 0 && (
                <ul className="space-y-1 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  {(showAllInsightLines
                    ? budgetInsight.lines
                    : budgetInsight.lines.slice(0, 1)
                  ).map((line) => (
                    <li key={line} className="flex gap-2">
                      <span aria-hidden>•</span>
                      <span>{line}</span>
                    </li>
                  ))}
                  {budgetInsight.lines.length > 1 && (
                    <li>
                      <button
                        type="button"
                        className="font-medium text-foreground hover:underline"
                        onClick={() => setShowAllInsightLines((v) => !v)}
                      >
                        {showAllInsightLines
                          ? "Show fewer"
                          : `+${budgetInsight.lines.length - 1} more`}
                      </button>
                    </li>
                  )}
                </ul>
              )}
              {plannedRecurring > 0 && (
                <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <span>Recurring commitments counted in the plan</span>
                  <InfoHint>
                    Includes active recurring commitments not seen in imported statements yet (
                    {recurringAdditionsSummary(recurringAdditions)}). Manage them on the Recurring
                    tab.
                  </InfoHint>
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-muted-foreground">
              Set your take-home pay above to see your 50/30/20 breakdown.
            </div>
          )}
        </CardContent>
      </Card>

      <OneTimeCandidatesCard
        candidates={oneTimeCandidates}
        onMark={(id) => toggleExclude(id, true)}
        onDismiss={dismissOneTime}
      />

      <ExpenseSorter
        monthLabel={formatMonthLabel(selectedMonth)}
        bucketTxns={bucketTxns}
        onMove={moveToBucket}
        onToggleExclude={toggleExclude}
      />

      <CollapsibleCard
        id="budget-import"
        title="Import & transactions"
        icon={Upload}
        summary={`${monthTxns.length} txn${monthTxns.length === 1 ? "" : "s"} this month`}
      >
        <div className="space-y-5">
          <div>
            <div className="text-sm font-semibold tracking-tight">Import statement</div>
            <p className="mb-3 mt-1 text-sm text-muted-foreground">
              Export a CSV from your bank and drop it here — we parse, categorize, and de-dupe. No
              bank login or credentials are ever stored.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={institution} onValueChange={setInstitution} disabled={busy}>
                <SelectTrigger aria-label="Institution" className="w-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {INSTITUTIONS.map((i) => (
                      <SelectItem key={i} value={i}>
                        {i}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                onChange={onFile}
                className="hidden"
              />
              <Button
                variant="outline"
                className="gap-1.5"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
              >
                <Upload className="size-4" /> Upload CSV
              </Button>
              <Button variant="ghost" className="gap-1.5" onClick={recategorizeAll} disabled={busy}>
                <RefreshCw className="size-4" /> Re-categorize all
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Re-applies the latest rules to past transactions (e.g. tagging credit-card payments as
              transfers). Your manual changes are kept.
            </p>
          </div>

          <RecentTransactions transactions={monthTxns} onChange={onChange} />
        </div>
      </CollapsibleCard>

      <BudgetBreakdownDialog
        active={breakdown}
        onClose={() => setBreakdown(null)}
        planSpend={budgetInsight.planSpend}
        oneTimeSpend={budgetInsight.oneTimeSpend}
        oneTimeCount={budgetInsight.oneTimeCount}
        plannedRecurring={budgetInsight.plannedRecurring}
        spentGroups={spentGroups}
        oneTimeTxns={oneTimeTxns}
        recurringGroups={recurringGroups}
      />
    </div>
  );
}

// Read-only reference view behind the three "This month vs plan" hero tiles. One
// Dialog reused for all three breakdowns, keyed by `active`. The header shows the
// authoritative `budgetInsight.*` total; the body lists the items that sum to it.
function BudgetBreakdownDialog({
  active,
  onClose,
  planSpend,
  oneTimeSpend,
  oneTimeCount,
  plannedRecurring,
  spentGroups,
  oneTimeTxns,
  recurringGroups,
}: {
  active: null | "spent" | "onetime" | "recurring";
  onClose: () => void;
  planSpend: number;
  oneTimeSpend: number;
  oneTimeCount: number;
  plannedRecurring: number;
  spentGroups: {
    key: BudgetBucket;
    label: string;
    subtotal: number;
    txns: Transaction[];
  }[];
  oneTimeTxns: Transaction[];
  recurringGroups: {
    key: BudgetBucket;
    label: string;
    subtotal: number;
    items: BudgetRecurringItem[];
  }[];
}) {
  const meta = {
    spent: {
      title: "Spent so far",
      total: planSpend,
      count: spentGroups.reduce((n, g) => n + g.txns.length, 0),
      description:
        "Money already posted to your accounts this month, counted against your 50/30/20 plan.",
    },
    onetime: {
      title: "One-time",
      total: oneTimeSpend,
      count: oneTimeCount,
      description: "Charges you marked as one-time — tracked, but left out of the plan.",
    },
    recurring: {
      title: "Upcoming recurring",
      total: plannedRecurring,
      count: recurringGroups.reduce((n, g) => n + g.items.length, 0),
      description:
        "Recurring commitments expected this month that haven’t posted to a statement yet.",
    },
  } as const;
  const current = active ? meta[active] : null;

  return (
    <Dialog open={active !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {current && (
          <>
            <DialogHeader>
              <DialogTitle>{current.title}</DialogTitle>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums">
                  {fmtMoney(current.total)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {current.count} {current.count === 1 ? "item" : "items"}
                </span>
              </div>
              <DialogDescription>{current.description}</DialogDescription>
            </DialogHeader>
            <div className="max-h-[60vh] overflow-y-auto">
              {current.count === 0 ? (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                  Nothing here yet.
                </p>
              ) : active === "spent" ? (
                <div className="space-y-3">
                  {spentGroups.map((g) => (
                    <div key={g.key}>
                      <div className="mb-1 flex items-center justify-between px-2 text-xs font-medium text-muted-foreground">
                        <span className="capitalize">{g.label}</span>
                        <span className="tabular-nums">{fmtMoney(g.subtotal)}</span>
                      </div>
                      <ul className="divide-y divide-border rounded-md border border-border/60 bg-muted/20">
                        {g.txns.map((t) => (
                          <li
                            key={t.id}
                            className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="truncate">
                                  {t.category ? cleanMerchantName(t.category) : "—"}
                                </span>
                                {t.recurringId && <Badge variant="secondary">Recurring</Badge>}
                              </div>
                              <TxnSubline t={t} />
                            </div>
                            <span className="shrink-0 tabular-nums">
                              {fmtMoney(Math.abs(t.amount))}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : active === "onetime" ? (
                <ul className="divide-y divide-border rounded-md border border-border/60 bg-muted/20">
                  {oneTimeTxns.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate">
                            {t.category ? cleanMerchantName(t.category) : "—"}
                          </span>
                          <Badge
                            variant="outline"
                            className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                          >
                            One-time
                          </Badge>
                        </div>
                        <TxnSubline t={t} />
                      </div>
                      <span className="shrink-0 tabular-nums">{fmtMoney(Math.abs(t.amount))}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="space-y-3">
                  {recurringGroups.map((g) => (
                    <div key={g.key}>
                      <div className="mb-1 flex items-center justify-between px-2 text-xs font-medium text-muted-foreground">
                        <span className="capitalize">{g.label}</span>
                        <span className="tabular-nums">{fmtMoney(g.subtotal)} planned</span>
                      </div>
                      <ul className="divide-y divide-border rounded-md border border-border/60 bg-muted/20">
                        {g.items.map((item) => (
                          <li
                            key={item.id}
                            className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="truncate">{cleanMerchantName(item.name)}</div>
                              <div className="truncate text-muted-foreground">
                                {recurringKindLabel(item.kind)} · {CADENCE_ABBR[item.cadence]}
                                {item.account ? ` · ${item.account}` : ""}
                                {` · ${fmtMoney(item.remainingMonthlyAmount)} planned`}
                                {item.lastPaidTxn
                                  ? ` · last paid ${fmtDate(item.lastPaidTxn.timestamp)}`
                                  : ""}
                              </div>
                            </div>
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                              {fmtMoney(item.monthlyAmount)}/mo
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function BudgetSettingsEditor({
  monthlyTakeHome,
  setMonthlyTakeHome,
  cadence,
  setCadence,
  anchorDate,
  setAnchorDate,
  payDaysRaw,
  setPayDaysRaw,
  onSave,
  busy,
}: {
  monthlyTakeHome: string;
  setMonthlyTakeHome: (v: string) => void;
  cadence: "monthly" | "semimonthly" | "biweekly" | "weekly" | "none";
  setCadence: (v: "monthly" | "semimonthly" | "biweekly" | "weekly" | "none") => void;
  anchorDate: string;
  setAnchorDate: (v: string) => void;
  payDaysRaw: string;
  setPayDaysRaw: (v: string) => void;
  onSave: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="take-home" className="text-xs font-medium">
          Monthly Take-home Pay
        </Label>
        <Input
          id="take-home"
          type="number"
          step="0.01"
          value={monthlyTakeHome}
          onChange={(e) => setMonthlyTakeHome(e.target.value)}
          placeholder="e.g. 5000"
          className="tabular-nums"
          disabled={busy}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pay-cadence" className="text-xs font-medium">
          Payday Frequency
        </Label>
        <Select
          value={cadence}
          onValueChange={(val) =>
            setCadence(val as "monthly" | "semimonthly" | "biweekly" | "weekly" | "none")
          }
          disabled={busy}
        >
          <SelectTrigger id="pay-cadence" className="w-full">
            <SelectValue placeholder="Select frequency" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Default (1st of month)</SelectItem>
            <SelectItem value="monthly">Monthly</SelectItem>
            <SelectItem value="semimonthly">Semimonthly</SelectItem>
            <SelectItem value="biweekly">Biweekly</SelectItem>
            <SelectItem value="weekly">Weekly</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {cadence !== "none" && (
        <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-3">
          {(cadence === "weekly" || cadence === "biweekly") && (
            <div className="space-y-1.5">
              <Label htmlFor="anchor-date" className="text-xs font-medium">
                Anchor Payday (First weekly/biweekly date)
              </Label>
              <Input
                id="anchor-date"
                type="date"
                value={anchorDate}
                onChange={(e) => setAnchorDate(e.target.value)}
                className="w-full"
                disabled={busy}
              />
              <p className="text-[10px] text-muted-foreground">
                Projections roll forward in increments from this date.
              </p>
            </div>
          )}

          {(cadence === "monthly" || cadence === "semimonthly") && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="pay-days" className="text-xs font-medium">
                  Payday Numbers (Comma-separated days)
                </Label>
                <Input
                  id="pay-days"
                  type="text"
                  value={payDaysRaw}
                  onChange={(e) => setPayDaysRaw(e.target.value)}
                  placeholder={cadence === "semimonthly" ? "1, 15" : "1"}
                  className="w-full"
                  disabled={busy}
                />
                <p className="text-[10px] text-muted-foreground">
                  Days of the month when you are paid, separated by commas (e.g. 15, 30).
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="fallback-anchor" className="text-xs font-medium">
                  Fallback Anchor Date (Optional)
                </Label>
                <Input
                  id="fallback-anchor"
                  type="date"
                  value={anchorDate}
                  onChange={(e) => setAnchorDate(e.target.value)}
                  className="w-full"
                  disabled={busy}
                />
              </div>
            </>
          )}
        </div>
      )}

      <Button
        type="button"
        className="w-full gap-1.5"
        onClick={onSave}
        disabled={busy || !monthlyTakeHome}
      >
        {busy ? <RefreshCw className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
        Save Settings
      </Button>
    </div>
  );
}

const SORTER_BUCKETS: { key: BudgetBucket; label: string; accent: string }[] = [
  { key: "needs", label: "Needs", accent: "text-sky-600 dark:text-sky-400" },
  { key: "wants", label: "Wants", accent: "text-foreground" },
  {
    key: "savings",
    label: "Savings",
    accent: "text-emerald-600 dark:text-emerald-400",
  },
];

// Sum imported transactions only. Budget bars may also include recurring
// commitments that are not visible in statement data yet.
function bucketSum(txns: Transaction[]): number {
  return txns.reduce((s, t) => (t.excludeFromBudget ? s : s + spendAmountOf(t)), 0);
}

function ExpenseSorter({
  monthLabel,
  bucketTxns,
  onMove,
  onToggleExclude,
}: {
  monthLabel: string;
  bucketTxns: Record<BudgetBucket, Transaction[]>;
  onMove: (id: string, group: BudgetBucket) => void | Promise<void>;
  onToggleExclude: (id: string, excluded: boolean) => void | Promise<void>;
}) {
  const [filter, setFilter] = useState<BudgetBucket | "all">("all");
  const total = bucketTxns.needs.length + bucketTxns.wants.length + bucketTxns.savings.length;
  const rows = (
    filter === "all"
      ? SORTER_BUCKETS.flatMap(({ key }) => bucketTxns[key].map((t) => ({ t, bucket: key })))
      : bucketTxns[filter].map((t) => ({ t, bucket: filter }))
  ).sort((a, b) => Math.abs(b.t.amount) - Math.abs(a.t.amount));
  const filters: {
    key: BudgetBucket | "all";
    label: string;
    count: number;
    sum: number;
  }[] = [
    {
      key: "all",
      label: "All",
      count: total,
      sum: SORTER_BUCKETS.reduce((sum, { key }) => sum + bucketSum(bucketTxns[key]), 0),
    },
    ...SORTER_BUCKETS.map(({ key, label }) => ({
      key,
      label,
      count: bucketTxns[key].length,
      sum: bucketSum(bucketTxns[key]),
    })),
  ];

  return (
    <CollapsibleCard
      id="budget-sorter"
      title="Sort expenses"
      icon={ListChecks}
      summary={`${total} this month · ${fmtMoney(filters[0].sum)}`}
    >
      <div className="space-y-3">
        <p className="-mt-2 text-sm text-muted-foreground">
          Tap Need / Want / Save — mark one-time charges that shouldn’t count toward the plan.
        </p>
        {total === 0 ? (
          <div className="rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-6 text-center text-sm text-muted-foreground">
            No categorized expenses for {monthLabel}. Step back with the arrows above to a month
            with imported statements, or import one below.
          </div>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              {SORTER_BUCKETS.map(({ key, label }) => (
                <div
                  key={key}
                  className="rounded-lg bg-muted/20 px-3 py-2 ring-1 ring-foreground/10"
                >
                  <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
                  <div className="text-sm font-semibold tabular-nums">
                    {fmtMoney(bucketSum(bucketTxns[key]))}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {filters.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={`rounded-full px-3 py-1 text-xs ring-1 transition-colors ${
                    filter === f.key
                      ? "bg-primary text-primary-foreground ring-primary/20"
                      : "bg-muted/40 text-muted-foreground ring-foreground/10 hover:text-foreground"
                  }`}
                >
                  {f.label} <span className="tabular-nums">{f.count}</span>
                  {f.sum > 0 && (
                    <span className="ml-1 tabular-nums text-current/75">{fmtMoney(f.sum)}</span>
                  )}
                </button>
              ))}
            </div>
            {rows.length === 0 ? (
              <div className="rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-6 text-center text-sm text-muted-foreground">
                No {filter === "all" ? "" : GROUP_LABELS[filter].toLowerCase()} expenses for{" "}
                {monthLabel}.
              </div>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border/60 bg-background">
                {rows.map(({ t, bucket }) => (
                  <ExpenseCard
                    key={t.id}
                    t={t}
                    bucket={bucket}
                    onMove={onMove}
                    onToggleExclude={onToggleExclude}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </CollapsibleCard>
  );
}

function ExpenseCard({
  t,
  bucket,
  onMove,
  onToggleExclude,
}: {
  t: Transaction;
  bucket: BudgetBucket;
  onMove: (id: string, group: BudgetBucket) => void | Promise<void>;
  onToggleExclude: (id: string, excluded: boolean) => void | Promise<void>;
}) {
  const excluded = !!t.excludeFromBudget;
  return (
    <li className="px-3 py-2 text-xs">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="truncate">{t.category ? cleanMerchantName(t.category) : "—"}</span>
            {excluded && (
              <Badge
                variant="outline"
                className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              >
                One-time
              </Badge>
            )}
            {!excluded && t.recurringId && <Badge variant="secondary">Recurring</Badge>}
          </div>
          <TxnSubline t={t} />
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 sm:justify-end">
          <span className="w-20 text-right text-sm tabular-nums">
            {fmtMoney(Math.abs(t.amount))}
          </span>
          <GroupPicker value={bucket} onChange={(g) => onMove(t.id, g)} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onToggleExclude(t.id, !excluded)}
            className="h-7 shrink-0 px-2 text-[11px] text-muted-foreground"
            title={excluded ? "Count this in the plan again" : "Mark as a one-time charge"}
          >
            {excluded ? "Include in plan" : "Mark one-time"}
          </Button>
        </div>
      </div>
    </li>
  );
}

function RecentTransactions({
  transactions,
  onChange,
}: {
  transactions: Transaction[];
  onChange: () => Promise<void>;
}) {
  const recent = [...transactions].sort((a, b) => b.timestamp - a.timestamp).slice(0, 20);

  async function recategorize(id: string, group: CategoryGroup) {
    await recategorizeTransaction({ data: { id, group } });
    await onChange();
  }

  if (!recent.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent transactions</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {recent.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate">{t.category ? cleanMerchantName(t.category) : "—"}</div>
                <TxnSubline t={t} className="text-xs" />
              </div>
              <Select
                value={t.categoryGroup ?? "wants"}
                onValueChange={(v) => recategorize(t.id, v as CategoryGroup)}
              >
                <SelectTrigger aria-label="Category group" className="h-7 w-auto text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(Object.keys(GROUP_LABELS) as CategoryGroup[]).map((g) => (
                      <SelectItem key={g} value={g}>
                        {GROUP_LABELS[g]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <span
                className={`w-20 shrink-0 text-right tabular-nums ${
                  t.amount < 0 ? "text-foreground" : "text-green-600 dark:text-green-500"
                }`}
              >
                {t.amount < 0 ? "-" : "+"}
                {fmtMoney(Math.abs(t.amount))}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ---------------- Recurring controls ---------------- */

function OneTimeCandidatesCard({
  candidates,
  onMark,
  onDismiss,
}: {
  candidates: OneTimeCandidate[];
  onMark: (id: string) => void | Promise<void>;
  onDismiss: (id: string) => void | Promise<void>;
}) {
  const [showAll, setShowAll] = useState(false);
  if (!candidates.length) return null;
  const visible = showAll ? candidates : candidates.slice(0, 3);

  return (
    <Card className="border-amber-500/25 bg-linear-to-br from-amber-500/8 to-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Receipt className="size-4 text-amber-600 dark:text-amber-400" />
          Possible one-time charges
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {visible.map((candidate) => (
            <div
              key={candidate.transactionId}
              className="flex flex-col gap-2 rounded-lg bg-background/70 p-3 ring-1 ring-foreground/10 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span className="truncate">{candidate.merchant}</span>
                  <Badge
                    variant="outline"
                    className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  >
                    {fmtMoney(candidate.amount)}
                  </Badge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {fmtDate(candidate.timestamp)} · {candidate.reason}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onMark(candidate.transactionId)}
                  className="h-8"
                >
                  Mark one-time
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onDismiss(candidate.transactionId)}
                  className="h-8 text-muted-foreground"
                >
                  Dismiss
                </Button>
              </div>
            </div>
          ))}
          {candidates.length > 3 && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : `Show all (${candidates.length})`}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
