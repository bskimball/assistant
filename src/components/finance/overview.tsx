import { fmtMoney } from "@/components/finance/shared";
import { SimplefinConnectionsCard } from "@/components/finance/simplefin-connections";
import type { FinanceTabProps } from "@/components/finance/shared";
import { useState, useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys, simplefinStatusQuery } from "@/lib/queries";
import {
  CaretRightIcon,
  CheckIcon,
  GearIcon,
  PencilSimpleIcon,
  PiggyBankIcon,
  PlusIcon,
  ReceiptIcon,
  SparkleIcon,
  TrashIcon,
  WalletIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveDailyFinance } from "@/server/domain";
import { acceptFinanceActions } from "@/server/finance";
import type { FinanceHubPayload } from "@/lib/finance-types";
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
  recurringItemsForMonth,
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
  const [manageAccounts, setManageAccounts] = useState(false);
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

  // Same paid/unpaid semantics as the Bills tab: active non-annual items expected
  // this month, matched via recurringMatchesTransaction inside recurringItemsForMonth.
  const currentMonth = today.slice(0, 7);
  const monthBillBuckets = recurringItemsForMonth(
    hub.subscriptions,
    monthTxns,
    undefined,
    currentMonth,
  );
  const billMonthItems = (["needs", "wants", "savings"] as const)
    .flatMap((bucket) => monthBillBuckets[bucket])
    .filter((item) => item.cadence !== "annual" && item.expectedThisMonth > 0);
  const billsTotal = billMonthItems.length;
  const billsPaid = billMonthItems.filter(
    (item) =>
      item.seenThisMonth &&
      (item.expectedThisMonth <= 1 || item.matchedCount >= item.expectedThisMonth),
  ).length;
  // Insights that already flag amount-change / likely-canceled for those bills.
  const billIds = new Set(billMonthItems.map((item) => item.id));
  const billsNeedingAttention = hub.recurringInsights.filter((insight) =>
    billIds.has(insight.subscriptionId),
  ).length;

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
                className="size-10 text-success transition-[scale,background-color,color] active:scale-[0.96]"
              >
                <CheckIcon className="size-4" weight="duotone" />
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
                <XIcon className="size-4" weight="duotone" />
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
                  className={`size-1.5 rounded-full ${synced ? "bg-success" : "bg-muted-foreground/40"}`}
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
              {manageAccounts && (
                <>
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
                    <PencilSimpleIcon className="size-4" weight="duotone" />
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
                    <TrashIcon className="size-4" weight="duotone" />
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-4">
      {/* a. Net worth + this month's cash flow */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Net worth" value={fmtMoney(hub.snapshot.netWorth)} hero />
        <Stat
          label="Cash flow (mo)"
          value={`${cashFlow < 0 ? "-" : "+"}${fmtMoney(Math.abs(cashFlow))}`}
          tone={cashFlow >= 0 ? "up" : "down"}
          hero
        />
        <Stat
          label={usePlannedIncome ? "Money in (mo)" : "Money in (MTD)"}
          value={fmtMoney(income)}
          tone="up"
        />
        <Stat label="Money out (mo)" value={fmtMoney(knownOutflow)} />
      </div>

      {plannedRecurring > 0 && (
        <p className="-mt-2 text-xs text-muted-foreground">
          Money out includes {fmtMoney(plannedRecurring)} of active recurring commitments not seen
          in imported statements yet.
        </p>
      )}

      {/* b. Bills health strip */}
      <BillsHealthStrip
        paid={billsPaid}
        total={billsTotal}
        needsAttention={billsNeedingAttention}
      />

      {/* c. Alerts / insights */}
      <SafeToSpendGuardrail result={hub.safeToSpend} />

      <CashFlowCalendarCard result={hub.cashFlowCalendar} />

      <CoachSuggestions items={adviceItems} today={today} flash={flash} loading={adviceLoading} />

      <DataQualityCard hub={hub} today={today} />

      {/* d. Recent transactions */}
      <TransactionsCard transactions={hub.transactions} />

      {/* e. Accounts (manage toggle) + emergency fund + bank connections at bottom */}
      <CollapsibleCard
        id="overview-accounts"
        title="Accounts"
        icon={WalletIcon}
        defaultOpen
        summary={fmtMoney(accountsTotal)}
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Net-worth balances</span>
            {balanceSourceDate && (
              <span className="text-xs font-normal text-muted-foreground">
                Balances from {fmtISODate(balanceSourceDate)}
              </span>
            )}
          </div>
          <Button
            type="button"
            variant={manageAccounts ? "secondary" : "ghost"}
            size="sm"
            className="gap-1.5 text-muted-foreground"
            onClick={() => {
              setManageAccounts((v) => {
                if (v) {
                  setShowAddAccount(false);
                  setEditingAccount(null);
                }
                return !v;
              });
            }}
            aria-pressed={manageAccounts}
          >
            <GearIcon className="size-3.5" weight="duotone" />
            {manageAccounts ? "Done" : "Manage"}
          </Button>
        </div>
        {accounts.length ? (
          <>
            <div className="mb-3 space-y-3 text-sm">
              {accountGroups.map(({ type, label, Icon, rows, subtotal }) => (
                <section key={type}>
                  <div className="mb-0.5 flex items-center justify-between gap-2 border-b border-border/60 pb-1">
                    <h3 className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <Icon className="size-3.5" weight="duotone" />
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
        {manageAccounts && (
          <>
            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground"
                onClick={() => setShowAddAccount((v) => !v)}
                aria-expanded={showAddAccount}
              >
                <PlusIcon className="size-3.5" weight="duotone" /> Add account
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
                  <PlusIcon className="size-4" weight="duotone" /> Save
                </Button>
              </form>
            )}
            {showAddAccount && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Add new balances below, or edit a saved row to rename an account, update its
                balance, or change its currency.
              </p>
            )}
          </>
        )}
      </CollapsibleCard>

      <EmergencyFundProgressCard fund={emergencyFund} monthlyContribution={emergencyContribution} />

      <SimplefinConnectionsCard
        status={simplefinQuery.data}
        loading={simplefinQuery.isLoading}
        onChange={refreshFinanceData}
        flash={flash}
        defaultOpen={false}
      />
    </div>
  );
}

function BillsHealthStrip({
  paid,
  total,
  needsAttention,
}: {
  paid: number;
  total: number;
  needsAttention: number;
}) {
  if (total === 0) {
    return (
      <Link
        to="/finance/recurring"
        className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2.5 transition-colors hover:bg-muted/30"
      >
        <div className="flex min-w-0 items-center gap-2">
          <ReceiptIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
          <div>
            <div className="text-xs font-medium">Bills this month</div>
            <div className="text-[11px] text-muted-foreground">
              No active bills tracked yet — open Bills to add them
            </div>
          </div>
        </div>
        <CaretRightIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
      </Link>
    );
  }

  const warning = needsAttention > 0;
  const tone = warning
    ? "border-warning/30 bg-warning/10 hover:bg-warning/15"
    : "border-success/25 bg-success/5 hover:bg-success/10";

  return (
    <Link
      to="/finance/recurring"
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors ${tone}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <ReceiptIcon
          className={`size-4 shrink-0 ${warning ? "text-warning" : "text-success"}`}
          weight="duotone"
        />
        <div className="min-w-0">
          <div className="text-xs font-medium">Bills this month</div>
          <div className="text-sm text-pretty">
            <span className="font-medium tabular-nums">
              {paid} of {total}
            </span>{" "}
            bill{total === 1 ? "" : "s"} paid
            {needsAttention > 0 && (
              <span className="text-warning-foreground">
                {" · "}
                {needsAttention} need{needsAttention === 1 ? "s" : ""} attention
              </span>
            )}
          </div>
        </div>
      </div>
      <CaretRightIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
    </Link>
  );
}

function SafeToSpendGuardrail({ result }: { result: FinanceHubPayload["safeToSpend"] }) {
  const tone =
    result.status === "on-track"
      ? "border-success/25 bg-success/5"
      : result.status === "over-plan"
        ? "border-destructive/30 bg-destructive/5"
        : result.status === "tight"
          ? "border-warning/30 bg-warning/5"
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
      ? "border-success/25 bg-success/5"
      : result.status === "negative"
        ? "border-destructive/30 bg-destructive/5"
        : "border-warning/30 bg-warning/5";
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
                className={`shrink-0 tabular-nums ${event.amount < 0 ? "text-destructive" : "text-info"}`}
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
const ADVICE_META: Record<
  FinanceAdviceItem["category"],
  { label: string; Icon: typeof SparkleIcon }
> = {
  budget: { label: "Budget", Icon: PiggyBankIcon },
  subscriptions: { label: "Subscriptions", Icon: SparkleIcon },
  investing: { label: "Investing", Icon: SparkleIcon },
  earn: { label: "Earn more", Icon: SparkleIcon },
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
          <SparkleIcon className="size-4 text-primary" weight="duotone" />
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
      <Card role="status" aria-busy="true" className="overflow-hidden border-primary/25 shadow-sm">
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
    <Card className="overflow-hidden border-primary/25 shadow-sm">
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
                  <meta.Icon className="size-4" weight="duotone" />
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
                  <CheckIcon className="size-3.5" weight="duotone" />
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
      ? "bg-success/10 text-success ring-success/20"
      : fund.status === "building"
        ? "bg-warning/10 text-warning-foreground ring-warning/20"
        : "bg-muted/40 text-muted-foreground ring-foreground/10";

  return (
    <Card className="overflow-hidden border-success/20 bg-linear-to-br from-success/6 to-card">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <PiggyBankIcon className="size-4 text-success" weight="duotone" />
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
              className="absolute inset-y-0 left-0 rounded-full bg-success transition-[width] duration-300 ease-out"
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

function TransactionsCard({ transactions }: { transactions: Transaction[] }) {
  const recent = [...transactions].sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-2">
        <CardTitle className="text-base">Recent transactions</CardTitle>
        <Button asChild variant="ghost" size="sm" className="shrink-0 text-muted-foreground">
          <Link to="/finance/transactions">View all →</Link>
        </Button>
      </CardHeader>
      <CardContent>
        {recent.length ? (
          <ul className="divide-y divide-border">
            {recent.map((transaction) => (
              <li
                key={transaction.id}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate">
                      {transaction.category ? cleanMerchantName(transaction.category) : "—"}
                    </span>
                    {transaction.categoryGroup && <GroupChip group={transaction.categoryGroup} />}
                  </div>
                  <TxnSubline t={transaction} className="text-xs" />
                </div>
                <span
                  className={`shrink-0 tabular-nums ${transaction.amount < 0 ? "text-destructive" : "text-success"}`}
                >
                  {transaction.amount < 0 ? "−" : "+"}
                  {fmtMoney(Math.abs(transaction.amount))}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No transactions yet. Connect your bank below or import a CSV statement on the Budget
            tab.
          </p>
        )}
      </CardContent>
    </Card>
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
  const dotColor = score === 4 ? "bg-success" : score >= 2 ? "bg-warning" : "bg-destructive";

  if (issues.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-muted-foreground">
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
