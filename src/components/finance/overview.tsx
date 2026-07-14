import { fmtMoney } from "@/components/finance/shared";
import { SimplefinConnectionsCard } from "@/components/finance/simplefin-connections";
import type { FinanceTabProps } from "@/components/finance/shared";
import { useState, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys, simplefinStatusQuery } from "@/lib/queries";
import {
  PiggyBank,
  Plus,
  Check,
  X,
  Sparkles,
  Trash2,
  Pencil,
  Activity,
  Wallet2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveDailyFinance } from "@/server/domain";
import { acceptFinanceActions, type FinanceHubPayload } from "@/server/finance";
import {
  subscriptionMonthlyCost,
  spendAmountOf,
  spendBucketOf,
  recurringBudgetBucket,
  cleanMerchantName,
  summarizeCashFlow,
  DEFAULT_BUDGET_TARGETS,
  type Transaction,
  type AccountBalance,
  type FinanceAdviceItem,
} from "@/lib/domain";
import {
  calculateEmergencyFund,
  recurringAdditionsForMonth,
  transactionsForMonth,
} from "@/lib/finance-math";
import {
  ACCOUNT_GROUP_META,
  CollapsibleCard,
  GroupChip,
  MiniStat,
  Stat,
  TxnSubline,
  cashLikeBalance,
  fmtDate,
  fmtISODate,
  inferAccountType,
  summarizeImportedAccounts,
} from "@/components/finance/shared";

export function OverviewTab({
  hub,
  today,
  adviceItems,
  adviceLoading,
  onChange,
  flash,
}: FinanceTabProps & {
  today: string;
  adviceItems: FinanceAdviceItem[];
  adviceLoading: boolean;
}) {
  const queryClient = useQueryClient();
  const simplefinQuery = useQuery(simplefinStatusQuery());
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingAccount, setEditingAccount] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editCurrency, setEditCurrency] = useState("USD");
  const [showAddAccount, setShowAddAccount] = useState(false);
  const accounts = hub.snapshot.accounts || [];
  const importedAccounts = summarizeImportedAccounts(hub.transactions);
  const savedBalanceNames = new Set(accounts.map((a) => a.account.toLowerCase()));
  const importedWithoutBalance = importedAccounts.filter(
    (a) => !savedBalanceNames.has(a.account.toLowerCase()),
  );
  const balanceSourceDate =
    hub.snapshotSourceDate && hub.snapshotSourceDate !== today ? hub.snapshotSourceDate : null;

  async function refreshFinanceData() {
    await Promise.all([
      onChange(),
      queryClient.invalidateQueries({ queryKey: queryKeys.simplefinStatus() }),
    ]);
  }

  async function saveAccounts(next: AccountBalance[]) {
    await saveDailyFinance({
      data: {
        date: today,
        finance: {
          date: today,
          accounts: next,
          positions: hub.snapshot.positions || [],
        },
      },
    });
    await refreshFinanceData();
  }

  async function addAccount(e: React.SyntheticEvent) {
    e.preventDefault();
    const amt = Number(amount);
    if (!name.trim() || !Number.isFinite(amt)) return;
    setBusy(true);
    try {
      const next = [...accounts];
      const idx = next.findIndex((a) => a.account.toLowerCase() === name.trim().toLowerCase());
      if (idx >= 0) next[idx] = { ...next[idx], amount: amt };
      else next.push({ account: name.trim(), amount: amt, currency: "USD" });
      await saveAccounts(next);
      setName("");
      setAmount("");
      flash("Balance saved.");
    } catch (err) {
      console.error(err);
      flash("Couldn’t save that balance.");
    } finally {
      setBusy(false);
    }
  }

  async function removeAccount(account: string) {
    setBusy(true);
    try {
      const next = accounts.filter((a) => a.account.toLowerCase() !== account.toLowerCase());
      await saveAccounts(next);
      if (editingAccount === account) setEditingAccount(null);
      flash("Account removed.");
    } catch (err) {
      console.error(err);
      flash("Couldn’t remove that account.");
    } finally {
      setBusy(false);
    }
  }

  function startEditAccount(account: AccountBalance) {
    setEditingAccount(account.account);
    setEditName(account.account);
    setEditAmount(String(account.amount));
    setEditCurrency(account.currency || "USD");
  }

  async function saveAccountEdit(originalAccount: string) {
    const trimmedName = editName.trim();
    const amt = Number(editAmount);
    const currency = editCurrency.trim().toUpperCase() || "USD";
    if (!trimmedName || !Number.isFinite(amt)) return;
    if (currency !== "USD") {
      flash("Finance totals currently support USD accounts only.");
      return;
    }

    const duplicate = accounts.some(
      (a) =>
        a.account.toLowerCase() !== originalAccount.toLowerCase() &&
        a.account.toLowerCase() === trimmedName.toLowerCase(),
    );
    if (duplicate) {
      flash("Another account already uses that name.");
      return;
    }

    setBusy(true);
    try {
      const next = accounts.map((a) =>
        a.account.toLowerCase() === originalAccount.toLowerCase()
          ? { ...a, account: trimmedName, amount: amt, currency }
          : a,
      );
      await saveAccounts(next);
      setEditingAccount(null);
      flash("Account updated.");
    } catch (err) {
      console.error(err);
      flash("Couldn’t update that account.");
    } finally {
      setBusy(false);
    }
  }

  const monthTxns = transactionsForMonth(hub.transactions, today.slice(0, 7));
  // Imported income only captures deposits to the accounts you've imported, so a
  // second paycheck landing in another account is missed. Prefer the monthly
  // take-home you set on the Budget tab (your full after-tax pay) when available.
  const takeHome = hub.budget?.monthlyTakeHome ?? 0;
  const usePlannedIncome = takeHome > 0;
  // Shared definition so Today / Finance / Analytics agree (transfers excluded).
  const { income, spend } = summarizeCashFlow(monthTxns, takeHome);
  const recurringAdditions = recurringAdditionsForMonth(
    hub.subscriptions,
    monthTxns,
    today.slice(0, 7),
  );
  const plannedRecurring =
    recurringAdditions.needs + recurringAdditions.wants + recurringAdditions.savings;
  const knownOutflow = spend + plannedRecurring;
  const cashFlow = income - knownOutflow;
  const targets = hub.budget?.targets ?? DEFAULT_BUDGET_TARGETS;
  const monthlyNeedsFromStatements = monthTxns
    .filter((t) => spendBucketOf(t.categoryGroup) === "needs" && !t.excludeFromBudget)
    .reduce((sum, t) => sum + spendAmountOf(t), 0);
  const monthlyEssentialExpenses = Math.max(
    monthlyNeedsFromStatements + recurringAdditions.needs,
    takeHome > 0 ? takeHome * targets.needs : 0,
  );
  const cashOnHand = cashLikeBalance(accounts);
  const recurringSavingsMonthly = hub.subscriptions
    .filter((s) => s.status === "active" && recurringBudgetBucket(s) === "savings")
    .reduce((sum, s) => sum + subscriptionMonthlyCost(s), 0);
  const emergencyContribution = Math.max(0, cashFlow, recurringSavingsMonthly);
  const emergencyFund = calculateEmergencyFund({
    monthlyEssentialExpenses,
    currentSavings: cashOnHand,
    monthlyContribution: emergencyContribution,
  });

  // An account is "synced" when its saved name matches a SimpleFIN display name
  // or a saved alias. Status may be loading/absent — then everything reads manual.
  const syncedNames = new Set<string>();
  if (simplefinQuery.data) {
    for (const acct of simplefinQuery.data.accounts) {
      if (acct.displayName) syncedNames.add(acct.displayName.toLowerCase());
      if (acct.name) syncedNames.add(acct.name.toLowerCase());
    }
    for (const alias of Object.values(simplefinQuery.data.aliases)) {
      if (alias) syncedNames.add(alias.toLowerCase());
    }
  }
  const isSyncedAccount = (accountName: string) =>
    syncedNames.has(accountName.trim().toLowerCase());

  // Group saved balances by inferred type for the single-source-of-truth card.
  const accountGroups = ACCOUNT_GROUP_META.map((meta) => {
    const rows = accounts.filter((a) => inferAccountType(a.account) === meta.type);
    return { ...meta, rows, subtotal: rows.reduce((s, a) => s + a.amount, 0) };
  }).filter((g) => g.rows.length > 0);
  const accountsTotal = accounts.reduce((s, a) => s + a.amount, 0);

  // One row of the Accounts card. Kept as a closure so grouped sections can reuse
  // the inline edit state without prop-drilling it through a child component.
  const renderAccountRow = (a: AccountBalance) => {
    const isEditing = editingAccount === a.account;
    const synced = isSyncedAccount(a.account);
    return (
      <li
        key={a.account}
        className="rounded-lg px-2 py-2 transition-[background-color] hover:bg-muted/30 sm:flex sm:items-center sm:justify-between"
      >
        {isEditing ? (
          <>
            <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_5rem]">
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                aria-label="Account name"
                className="h-10 sm:h-8"
              />
              <Input
                value={editAmount}
                onChange={(e) => setEditAmount(e.target.value)}
                inputMode="decimal"
                aria-label="Account balance"
                className="h-10 sm:h-8"
              />
              <Input
                value={editCurrency}
                onChange={(e) => setEditCurrency(e.target.value)}
                aria-label="Currency"
                className="h-10 uppercase sm:h-8"
                maxLength={3}
                disabled
              />
            </div>
            <div className="mt-2 flex shrink-0 items-center gap-1 sm:mt-0 sm:pl-2">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => saveAccountEdit(a.account)}
                disabled={busy || !editName.trim() || !editAmount}
                aria-label={`Save ${a.account}`}
                title="Save account"
                className="size-10 text-emerald-600 transition-[scale,background-color,color] active:scale-[0.96] dark:text-emerald-400"
              >
                <Check className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setEditingAccount(null)}
                disabled={busy}
                aria-label={`Cancel editing ${a.account}`}
                title="Cancel"
                className="size-10 text-muted-foreground transition-[scale,background-color,color] active:scale-[0.96]"
              >
                <X className="size-4" />
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate">{a.account}</span>
              <span
                className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground"
                title={synced ? "Synced from your bank connection" : "Entered manually"}
              >
                <span
                  className={`size-1.5 rounded-full ${synced ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                />
                {synced ? "Synced" : "Manual"}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <span
                className={`tabular-nums ${a.amount < 0 ? "text-destructive" : "text-muted-foreground"}`}
              >
                {fmtMoney(a.amount)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => startEditAccount(a)}
                disabled={busy}
                aria-label={`Edit ${a.account}`}
                title="Edit account"
                className="size-10 text-muted-foreground transition-[scale,background-color,color] active:scale-[0.96]"
              >
                <Pencil className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => removeAccount(a.account)}
                disabled={busy}
                aria-label={`Remove ${a.account}`}
                title="Remove account"
                className="size-10 text-muted-foreground transition-[scale,background-color,color] active:scale-[0.96] hover:text-destructive"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat
          label="Cash flow (mo)"
          value={`${cashFlow < 0 ? "-" : "+"}${fmtMoney(Math.abs(cashFlow))}`}
          tone={cashFlow >= 0 ? "up" : "down"}
          hero
        />
        <Stat
          label={usePlannedIncome ? "Income (mo)" : "Income (MTD)"}
          value={fmtMoney(income)}
          tone="up"
        />
        <Stat label="Known outflow (mo)" value={fmtMoney(knownOutflow)} />
      </div>

      {plannedRecurring > 0 && (
        <p className="-mt-2 text-xs text-muted-foreground">
          Known outflow includes {fmtMoney(plannedRecurring)} of active recurring commitments not
          seen in imported statements yet.
        </p>
      )}

      <SafeToSpendGuardrail result={hub.safeToSpend} />

      <CashFlowCalendarCard result={hub.cashFlowCalendar} />

      <CoachSuggestions items={adviceItems} today={today} flash={flash} loading={adviceLoading} />

      <DataQualityCard hub={hub} today={today} />

      <CollapsibleCard
        id="overview-accounts"
        title="Accounts"
        icon={Wallet2}
        defaultOpen
        summary={fmtMoney(accountsTotal)}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Net-worth balances</span>
          {balanceSourceDate && (
            <span className="text-xs font-normal text-muted-foreground">
              Balances from {fmtISODate(balanceSourceDate)}
            </span>
          )}
        </div>
        {accounts.length ? (
          <>
            <div className="mb-3 space-y-3 text-sm">
              {accountGroups.map(({ type, label, Icon, rows, subtotal }) => (
                <section key={type}>
                  <div className="mb-0.5 flex items-center justify-between gap-2 border-b border-border/60 pb-1">
                    <h3 className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <Icon className="size-3.5" />
                      {label}
                    </h3>
                    <span
                      className={`text-xs tabular-nums ${subtotal < 0 ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {fmtMoney(subtotal)}
                    </span>
                  </div>
                  <ul className="space-y-1">{rows.map(renderAccountRow)}</ul>
                </section>
              ))}
              <div className="flex items-center justify-between gap-2 border-t pt-2 text-sm font-medium">
                <span>Accounts total</span>
                <span className={`tabular-nums ${accountsTotal < 0 ? "text-destructive" : ""}`}>
                  {fmtMoney(accountsTotal)}
                </span>
              </div>
              {Math.round(hub.snapshot.netWorth) !== Math.round(accountsTotal) && (
                <p className="mt-1! text-[11px] text-muted-foreground">
                  Net worth {fmtMoney(hub.snapshot.netWorth)} also counts{" "}
                  {fmtMoney(hub.snapshot.netWorth - accountsTotal)} of manual holdings tracked on
                  the Investments tab. Synced holdings are already included in their account
                  balances.
                </p>
              )}
            </div>
            {importedWithoutBalance.length > 0 && (
              <div className="mb-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                <div className="text-xs font-medium text-foreground">
                  Imported statements without balances
                </div>
                <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                  {importedWithoutBalance.map((a) => (
                    <li key={a.account} className="flex items-center justify-between gap-2">
                      <span>{a.account}</span>
                      <span className="shrink-0 tabular-nums">
                        {a.count} txn{a.count === 1 ? "" : "s"} · last {fmtDate(a.lastSeen)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : importedAccounts.length ? (
          <div className="mb-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
            <div className="text-sm font-medium text-foreground">Imported statement accounts</div>
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
              {importedAccounts.map((a) => (
                <li key={a.account} className="flex items-center justify-between gap-2">
                  <span>{a.account}</span>
                  <span className="shrink-0 tabular-nums">
                    {a.count} txn{a.count === 1 ? "" : "s"} · last {fmtDate(a.lastSeen)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Add current balances below to turn imported statement accounts into a net-worth
              baseline.
            </p>
          </div>
        ) : (
          <div className="mb-3 text-sm text-muted-foreground">
            No accounts yet. Add your BoA, M&T, Capital One, Robinhood, and ADP 401k balances.
          </div>
        )}
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground"
            onClick={() => setShowAddAccount((v) => !v)}
            aria-expanded={showAddAccount}
          >
            <Plus className="size-3.5" /> Add account
          </Button>
        </div>
        {showAddAccount && (
          <form onSubmit={addAccount} className="mt-2 flex items-center gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Account (e.g. BoA Checking)"
              className="flex-1"
              disabled={busy}
            />
            <Input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Balance"
              className="w-32"
              disabled={busy}
            />
            <Button
              type="submit"
              size="sm"
              className="gap-1"
              disabled={busy || !name.trim() || !amount}
            >
              <Plus className="size-4" /> Save
            </Button>
          </form>
        )}
        {showAddAccount && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Add new balances below, or edit a saved row to rename an account, update its balance, or
            change its currency.
          </p>
        )}
      </CollapsibleCard>

      <EmergencyFundProgressCard fund={emergencyFund} monthlyContribution={emergencyContribution} />

      <TransactionsCard transactions={hub.transactions} />

      <SimplefinConnectionsCard
        status={simplefinQuery.data}
        loading={simplefinQuery.isLoading}
        onChange={refreshFinanceData}
        flash={flash}
      />
    </div>
  );
}

function SafeToSpendGuardrail({ result }: { result: FinanceHubPayload["safeToSpend"] }) {
  const tone =
    result.status === "on-track"
      ? "border-emerald-500/25 bg-emerald-500/5"
      : result.status === "over-plan"
        ? "border-destructive/30 bg-destructive/5"
        : result.status === "tight"
          ? "border-amber-500/30 bg-amber-500/5"
          : "border-border bg-muted/20";
  const statusLabel: Record<typeof result.status, string> = {
    unavailable: "Setup needed",
    "on-track": "On track",
    tight: "Tight",
    "over-plan": "Over plan",
  };

  return (
    <div className={`rounded-lg border px-3 py-2.5 ${tone}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium">Monthly budget guardrail</div>
          <div className="text-[11px] text-muted-foreground">Not available cash or net worth</div>
        </div>
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {statusLabel[result.status]}
        </span>
      </div>
      {result.status === "unavailable" ? (
        <p className="mt-2 text-xs text-muted-foreground">{result.explanation}</p>
      ) : (
        <>
          <div className="mt-2 flex items-end justify-between gap-3">
            <div>
              <div className="text-lg font-semibold tabular-nums">
                {fmtMoney(result.safeToSpendThisMonth)}
              </div>
              <div className="text-[11px] text-muted-foreground">safe to spend this month</div>
            </div>
            <div className="text-right">
              <div className="font-medium tabular-nums">
                {fmtMoney(result.safeToSpendPerDay)}/day
              </div>
              <div className="text-[11px] text-muted-foreground">
                {result.remainingDays} day{result.remainingDays === 1 ? "" : "s"} left
              </div>
            </div>
          </div>
          <details className="mt-2 border-t border-current/10 pt-2 text-[11px] text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">
              Show calculation
            </summary>
            <div className="mt-2 space-y-1 tabular-nums">
              <GuardrailLine label="Monthly take-home" value={result.monthlyTakeHome} />
              <GuardrailLine label="Posted plan spending" value={-result.postedPlanSpend} />
              <GuardrailLine label="Upcoming recurring" value={-result.upcomingRecurring} />
              <GuardrailLine label="One-time spending" value={-result.oneTimeSpend} />
              <GuardrailLine
                label="Left before savings"
                value={result.remainingAfterCommitted}
                strong
              />
              <GuardrailLine label="Savings target" value={result.savingsTarget} />
              <GuardrailLine label="Savings committed" value={result.savingsCommitted} />
              <GuardrailLine label="Still needed for savings" value={-result.savingsReserve} />
              <GuardrailLine label="Safe to spend" value={result.safeToSpendThisMonth} strong />
            </div>
            <p className="mt-2 text-pretty">{result.explanation}</p>
          </details>
        </>
      )}
    </div>
  );
}

function GuardrailLine({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: number;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 ${strong ? "font-medium text-foreground" : ""}`}
    >
      <span>{label}</span>
      <span>
        {value < 0 ? "−" : value > 0 ? "+" : ""}
        {fmtMoney(Math.abs(value))}
      </span>
    </div>
  );
}

function CashFlowCalendarCard({ result }: { result: FinanceHubPayload["cashFlowCalendar"] }) {
  const tone =
    result.status === "healthy"
      ? "border-emerald-500/25 bg-emerald-500/5"
      : result.status === "negative"
        ? "border-destructive/30 bg-destructive/5"
        : "border-amber-500/30 bg-amber-500/5";
  const statusLabel: Record<typeof result.status, string> = {
    healthy: "Healthy",
    tight: "Tight",
    negative: "Below zero",
  };
  const upcoming = result.events.slice(0, 4);

  return (
    <div className={`rounded-lg border px-3 py-2.5 ${tone}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium">30-day cash-flow outlook</div>
          <div className="text-[11px] text-muted-foreground">Cash, checking, and savings only</div>
        </div>
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {statusLabel[result.status]}
        </span>
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div>
          <div className="text-lg font-semibold tabular-nums">
            {fmtMoney(result.projectedFloor)}
          </div>
          <div className="text-[11px] text-muted-foreground">
            projected floor · {fmtISODate(result.projectedFloorDate)}
          </div>
        </div>
        <span className="text-right text-[11px] text-muted-foreground">
          {result.horizonDays}-day view
        </span>
      </div>
      {upcoming.length > 0 && (
        <ul className="mt-2 divide-y divide-border/50 text-xs">
          {upcoming.map((event, index) => (
            <li
              key={`${event.date}-${event.type}-${event.label}-${index}`}
              className="flex items-center justify-between gap-2 py-1.5"
            >
              <span className="min-w-0 truncate">
                <span className="mr-1.5 text-muted-foreground">{fmtISODate(event.date)}</span>
                {event.label}
              </span>
              <span
                className={`shrink-0 tabular-nums ${event.amount < 0 ? "text-destructive" : "text-emerald-700 dark:text-emerald-400"}`}
              >
                {event.amount < 0 ? "-" : "+"}
                {fmtMoney(Math.abs(event.amount))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Coach's "next moves" — always visible when suggestions exist (never
// collapsed), compact and scannable. This is the single home for finance coach
// suggestions; the Budget tab intentionally has none. Shows the top 3.
const ADVICE_META: Record<FinanceAdviceItem["category"], { label: string; Icon: typeof Sparkles }> =
  {
    budget: { label: "Budget", Icon: PiggyBank },
    subscriptions: { label: "Subscriptions", Icon: Sparkles },
    investing: { label: "Investing", Icon: Sparkles },
    earn: { label: "Earn more", Icon: Sparkles },
  };

const FINANCE_HIGHLIGHT_RE = /(\$[\d,]+(?:\.\d+)?|\d+(?:\.\d+)?%?)/;

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

function CoachSuggestions({
  items,
  today,
  flash,
  loading = false,
}: {
  items: FinanceAdviceItem[];
  today: string;
  flash: (msg: string) => void;
  loading?: boolean;
}) {
  const topItems = items.slice(0, 3);
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [acceptedItems, setAcceptedItems] = useState<Set<number>>(new Set());

  useEffect(() => {
    setAcceptedItems(new Set());
    setBusyIndex(null);
  }, [items]);

  // Shared chrome so the skeleton and loaded states have identical framing (no
  // layout shift when the real advice swaps in).
  const header = (
    <CardHeader className="pb-2">
      <CardTitle className="flex items-center justify-between gap-2 text-sm">
        <span className="flex items-center gap-2 font-semibold tracking-tight">
          <Sparkles className="size-4 text-primary" />
          Next moves
        </span>
        <span className="text-[11px] font-normal text-muted-foreground">Coach</span>
      </CardTitle>
    </CardHeader>
  );

  // Render the container immediately with a tasteful skeleton while the (slow,
  // un-awaited) Grok advice request is in flight; genuinely empty advice → null.
  if (!topItems.length) {
    if (!loading) return null;
    return (
      <Card
        role="status"
        aria-busy="true"
        className="overflow-hidden border-primary/25 bg-card shadow-sm"
      >
        <span className="sr-only">Loading coach suggestions…</span>
        {header}
        <CardContent className="pt-0">
          <ul className="divide-y divide-border/50" aria-hidden="true">
            {[0, 1, 2].map((row) => (
              <li key={row} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <div className="mt-0.5 size-8 shrink-0 animate-pulse rounded-md bg-primary/10" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-2.5 w-20 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-full animate-pulse rounded bg-muted" />
                  {row !== 1 && <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />}
                </div>
                <div className="mt-0.5 h-8 w-20 shrink-0 animate-pulse rounded-md bg-muted" />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    );
  }

  async function acceptOne(item: FinanceAdviceItem, index: number) {
    setBusyIndex(index);
    try {
      await acceptFinanceActions({ data: { date: today, items: [item] } });
      setAcceptedItems((prev) => new Set(prev).add(index));
      flash("Added to today’s tasks.");
    } catch (err) {
      console.error(err);
      flash("Couldn’t add that suggestion.");
    } finally {
      setBusyIndex(null);
    }
  }

  return (
    <Card className="overflow-hidden border-primary/25 bg-card shadow-sm">
      {header}
      <CardContent className="pt-0">
        <ul className="divide-y divide-border/50">
          {topItems.map((item, index) => {
            const meta = ADVICE_META[item.category];
            const accepted = acceptedItems.has(index);
            return (
              <li
                key={`${item.category}-${index}`}
                className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <meta.Icon className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-medium text-muted-foreground">{meta.label}</div>
                  <p className="mt-0.5 text-pretty text-sm leading-6">
                    {renderHighlightedAdvice(item.text)}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={accepted ? "secondary" : "outline"}
                  onClick={() => acceptOne(item, index)}
                  disabled={busyIndex !== null || accepted}
                  className="mt-0.5 h-8 shrink-0 gap-1.5 transition-[scale,background-color,color,box-shadow] active:scale-[0.96]"
                >
                  <Check className="size-3.5" />
                  <span className="hidden sm:inline">{accepted ? "Added" : "Add to tasks"}</span>
                  <span className="sm:hidden">{accepted ? "Added" : "Add"}</span>
                </Button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function EmergencyFundProgressCard({
  fund,
  monthlyContribution,
}: {
  fund: ReturnType<typeof calculateEmergencyFund>;
  monthlyContribution: number;
}) {
  const progress = fund.target > 0 ? Math.min(100, (fund.currentSavings / fund.target) * 100) : 0;
  const minimumProgress =
    fund.target > 0 ? Math.min(100, (fund.minimumTarget / fund.target) * 100) : 0;
  const statusLabel: Record<typeof fund.status, string> = {
    "not-started": "Build first month",
    building: "Core buffer funded",
    funded: "Fully funded",
    surplus: "Surplus cash",
  };
  const statusClass =
    fund.status === "funded" || fund.status === "surplus"
      ? "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300"
      : fund.status === "building"
        ? "bg-amber-500/10 text-amber-700 ring-amber-500/20 dark:text-amber-300"
        : "bg-muted/40 text-muted-foreground ring-foreground/10";

  return (
    <Card className="overflow-hidden border-emerald-500/20 bg-linear-to-br from-emerald-500/6 to-card">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <PiggyBank className="size-4 text-emerald-600 dark:text-emerald-400" />
            Emergency fund
          </span>
          <span
            className={`rounded-full px-2 py-1 text-[10px] font-medium uppercase tracking-wide ring-1 ${statusClass}`}
          >
            {statusLabel[fund.status]}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="mb-1 flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">
              {fund.monthsCovered.toFixed(1)} months covered
            </span>
            <span className="tabular-nums text-muted-foreground">
              {fmtMoney(fund.currentSavings)} / {fmtMoney(fund.target)}
            </span>
          </div>
          <div className="relative h-3 overflow-hidden rounded-full bg-muted">
            <span
              className="absolute inset-y-0 left-0 w-px bg-foreground/35"
              style={{ left: `${minimumProgress}%` }}
              aria-hidden
            />
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-emerald-500 transition-[width] duration-300 ease-out"
              style={{ width: `${progress}%` }}
              aria-hidden
            />
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
            <span>3-month floor {fmtMoney(fund.minimumTarget)}</span>
            <span>6-month target</span>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <MiniStat label="Monthly essentials" value={fmtMoney(fund.monthlyEssentialExpenses)} />
          <MiniStat
            label={fund.shortfall > 0 ? "Shortfall" : "Surplus"}
            value={fmtMoney(fund.shortfall > 0 ? fund.shortfall : fund.surplus)}
          />
          <MiniStat
            label="Time to target"
            value={
              fund.monthsToTarget === null
                ? "Set transfer"
                : fund.monthsToTarget === 0
                  ? "Ready"
                  : `${fund.monthsToTarget} mo`
            }
          />
        </div>
        <p className="text-pretty text-xs text-muted-foreground">
          Cash-like balances are compared with essential monthly expenses.{" "}
          {monthlyContribution > 0
            ? `${fmtMoney(monthlyContribution)}/mo of surplus or recurring savings is available to close the gap.`
            : "Add a recurring savings transfer or create monthly surplus to estimate the finish date."}
        </p>
      </CardContent>
    </Card>
  );
}

// One transaction row shared by the Overview transactions list. When an account
// filter is active the row's account text is redundant, so it can be dropped.
function TxnRow({ t, hideAccount }: { t: Transaction; hideAccount?: boolean }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate">{t.category ? cleanMerchantName(t.category) : "—"}</span>
          {t.categoryGroup && <GroupChip group={t.categoryGroup} />}
        </div>
        <TxnSubline t={t} className="text-xs" hideAccount={hideAccount} />
      </div>
      <span
        className={`shrink-0 tabular-nums ${
          t.amount < 0 ? "text-foreground" : "text-green-600 dark:text-green-500"
        }`}
      >
        {t.amount < 0 ? "-" : "+"}
        {fmtMoney(Math.abs(t.amount))}
      </span>
    </li>
  );
}

const TXN_PAGE_INITIAL = 15;
const TXN_PAGE_STEP = 25;

// Full transactions view: account filter chips, per-account verification summary,
// and a paginated newest-first list — so the owner can confirm exactly what was
// pulled per account.
function TransactionsCard({ transactions }: { transactions: Transaction[] }) {
  const [account, setAccount] = useState<string | null>(null);
  const [visible, setVisible] = useState(TXN_PAGE_INITIAL);

  // Distinct accounts (case-insensitive) with counts, most-recent activity first.
  // hub.transactions can be 600+ rows, so memoize the sweep.
  const accountChips = useMemo(() => summarizeImportedAccounts(transactions), [transactions]);

  // Newest first, filtered to the selected account (case-insensitive) when set.
  const filtered = useMemo(() => {
    const key = account?.toLowerCase();
    return [...transactions]
      .filter((t) => (key ? t.account?.trim().toLowerCase() === key : true))
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [transactions, account]);

  // Verification summary for a selected account: how many pulled and the span.
  const selectedSummary = useMemo(() => {
    if (!account || filtered.length === 0) return null;
    const last = filtered[0].timestamp;
    const first = filtered[filtered.length - 1].timestamp;
    return { count: filtered.length, first, last };
  }, [account, filtered]);

  function selectAccount(next: string | null) {
    setAccount(next);
    setVisible(TXN_PAGE_INITIAL);
  }

  const shown = filtered.slice(0, visible);

  return (
    <CollapsibleCard
      id="overview-transactions"
      title="Transactions"
      icon={Activity}
      summary={`${transactions.length.toLocaleString()} transactions`}
    >
      {transactions.length ? (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5">
            <FilterChip
              label="All"
              count={transactions.length}
              active={account === null}
              onClick={() => selectAccount(null)}
            />
            {accountChips.map((a) => (
              <FilterChip
                key={a.account}
                label={a.account}
                count={a.count}
                active={account?.toLowerCase() === a.account.toLowerCase()}
                onClick={() => selectAccount(a.account)}
              />
            ))}
          </div>

          {selectedSummary && (
            <p className="mb-2 text-xs text-muted-foreground">
              <span className="tabular-nums">{selectedSummary.count}</span> transaction
              {selectedSummary.count === 1 ? "" : "s"} · first{" "}
              <span className="tabular-nums">{fmtDate(selectedSummary.first)}</span> · last{" "}
              <span className="tabular-nums">{fmtDate(selectedSummary.last)}</span>
            </p>
          )}

          <ul className="divide-y divide-border">
            {shown.map((t) => (
              <TxnRow key={t.id} t={t} hideAccount={account !== null} />
            ))}
          </ul>

          {visible < filtered.length && (
            <div className="mt-3 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setVisible((v) => v + TXN_PAGE_STEP)}
              >
                Show more
                <span className="ml-1 text-muted-foreground tabular-nums">
                  ({filtered.length - visible} left)
                </span>
              </Button>
            </div>
          )}

          <p className="mt-2 text-[11px] text-muted-foreground">
            Pulled automatically from your bank sync and statement imports. Categorize and manage
            every transaction on the Budget tab.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No transactions yet. Connect your bank below or import a CSV statement on the Budget tab.
        </p>
      )}
    </CollapsibleCard>
  );
}

// Rounded filter pill with a trailing count, used for the account filter row.
function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-muted/40 text-muted-foreground hover:bg-muted"
      }`}
    >
      <span className="truncate">{label}</span>
      <span aria-hidden className={active ? "text-primary-foreground/60" : "text-border"}>
        ·
      </span>
      <span
        className={`tabular-nums ${active ? "text-primary-foreground/80" : "text-muted-foreground/70"}`}
      >
        {count.toLocaleString()}
      </span>
    </button>
  );
}

function DataQualityCard({ hub, today }: { hub: FinanceHubPayload; today: string }) {
  const month = today.slice(0, 7);
  const monthTxns = transactionsForMonth(hub.transactions, month);
  const importedAccountCount = summarizeImportedAccounts(hub.transactions).length;
  const lastTxn = hub.transactions.reduce<Transaction | null>(
    (latest, t) => (!latest || t.timestamp > latest.timestamp ? t : latest),
    null,
  );
  const importedIncome = monthTxns
    .filter((t) => t.amount > 0 && t.categoryGroup === "income")
    .reduce((s, t) => s + t.amount, 0);
  const takeHome = hub.budget?.monthlyTakeHome ?? 0;
  const uncategorized = hub.transactions.filter((t) => !t.categoryGroup).length;
  const confidenceChecks = [
    {
      label: "Statements",
      value: monthTxns.length
        ? `${monthTxns.length} transaction${monthTxns.length === 1 ? "" : "s"} this month`
        : "No current-month import",
      ok: monthTxns.length > 0,
    },
    {
      label: "Income baseline",
      value:
        takeHome > 0
          ? `${fmtMoney(takeHome)} planned take-home`
          : importedIncome > 0
            ? `${fmtMoney(importedIncome)} imported MTD`
            : "Missing take-home pay",
      ok: takeHome > 0 || importedIncome > 0,
    },
    {
      label: "Balances",
      value: hub.snapshot.accounts?.length
        ? `${hub.snapshot.accounts.length} account${hub.snapshot.accounts.length === 1 ? "" : "s"} saved`
        : importedAccountCount
          ? `${importedAccountCount} statement account${importedAccountCount === 1 ? "" : "s"}; balances missing`
          : "No account balances",
      ok: (hub.snapshot.accounts?.length ?? 0) > 0,
    },
    {
      label: "Categories",
      value: uncategorized ? `${uncategorized} need review` : "Rules applied",
      ok: uncategorized === 0,
    },
  ];
  const score = confidenceChecks.filter((c) => c.ok).length;
  const issues = confidenceChecks.filter((c) => !c.ok);
  const dotColor = score === 4 ? "bg-green-500" : score >= 2 ? "bg-amber-500" : "bg-destructive";

  if (issues.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5 font-medium text-foreground">
        <span className={`size-1.5 rounded-full ${dotColor}`} />
        Data confidence {score}/4
      </span>
      <span>· {monthTxns.length} txns this month</span>
      {lastTxn && <span>· last seen {fmtDate(lastTxn.timestamp)}</span>}
      {issues.length > 0 && (
        <span className="text-destructive">· {issues.map((c) => c.value).join(", ")}</span>
      )}
    </div>
  );
}

/* ---------------- Budget (50/30/20) ---------------- */
