import { fmtMoney } from "@/components/finance/shared";
import { SimplefinConnectionsCard } from "@/components/finance/simplefin-connections";
import type { FinanceTabProps } from "@/components/finance/shared";
import {
  useMemo,
  useState,
  useEffect,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  type SyntheticEvent,
} from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys, simplefinStatusQuery } from "@/lib/queries";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretRightIcon,
  ChartLineIcon,
  CheckIcon,
  EyeIcon,
  GearIcon,
  PencilSimpleIcon,
  PiggyBankIcon,
  PlusIcon,
  ReceiptIcon,
  ShieldCheckIcon,
  SparkleIcon,
  TrashIcon,
  TrendDownIcon,
  TrendUpIcon,
  WalletIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { saveDailyFinance } from "@/server/domain";
import { acceptFinanceActions, setTransactionWatchlist } from "@/server/finance";
import type { FinanceHubPayload } from "@/lib/finance-types";
import {
  WATCHLIST_IDS,
  WATCHLIST_META,
  type Transaction,
  type AccountBalance,
  type FinanceAdviceItem,
  type WatchlistId,
} from "@/lib/domain";
import {
  recurringItemsForMonth,
  rollupWatchlistMonth,
  transactionsBeforeMonth,
  transactionsForMonth,
  type EmergencyFundResult,
} from "@/lib/finance-math";
import {
  ACCOUNT_GROUP_META,
  Stat,
  TxnSubline,
  displayMerchant,
  fmtDate,
  fmtISODate,
  summarizeImportedAccounts,
} from "@/components/finance/shared";
import { type AccountType, classifyAccount } from "@/lib/finance-accounts";

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

  const currentMonth = today.slice(0, 7);
  const monthTxns = transactionsForMonth(hub.transactions, currentMonth);
  // Same plan math as the Budget tab (including prior-month weekly recurring
  // anchors). Overview never re-derives moneyOut — only displays `money.*`.
  const priorTxns = transactionsBeforeMonth(hub.transactions, currentMonth);
  const monthBillBuckets = recurringItemsForMonth(
    hub.subscriptions,
    monthTxns,
    priorTxns,
    currentMonth,
  );
  // Server computes current-month insight once on the hub (shared with safe-to-spend).
  const money = hub.budgetInsight;
  const usePlannedIncome = money.usingTakeHome;
  const moneyIn = money.moneyIn;
  const knownOutflow = money.moneyOut;
  const cashFlow = money.leftAfterOut;
  const oneTimeInCashOut = money.oneTimeSpend;
  const savingsTarget = money.savingsTarget;
  const savingsPosted = money.statementBuckets.savings;
  const savingsRemainingTarget = money.savingsTargetRemaining;
  const planBuckets = money.statementBuckets;
  const recurringByBucket = money.unpaidRecurring;
  const emergencyFund = hub.emergencyFund;

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
    const rows = accounts.filter((a) => classifyAccount(a.account) === meta.type);
    return { ...meta, rows, subtotal: rows.reduce((s, a) => s + a.amount, 0) };
  }).filter((g) => g.rows.length > 0);
  const accountsTotal = accounts.reduce((s, a) => s + a.amount, 0);

  // Same paid/unpaid semantics as the Bills tab: active non-annual items expected
  // this month, matched via recurringMatchesTransaction inside recurringItemsForMonth.
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
      {/* Truth board: KPIs + ledger + guardrail */}
      <div className="zen-card space-y-4 p-4 sm:p-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Net worth"
            value={fmtMoney(hub.snapshot.netWorth)}
            hero
            icon={ChartLineIcon}
          />
          <Stat
            label="Left after out"
            value={`${cashFlow < 0 ? "-" : "+"}${fmtMoney(Math.abs(cashFlow))}`}
            tone={cashFlow >= 0 ? "up" : "down"}
            hero
            icon={cashFlow >= 0 ? TrendUpIcon : TrendDownIcon}
          />
          <Stat
            label={usePlannedIncome ? "Money in (mo)" : "Money in (MTD)"}
            value={fmtMoney(moneyIn)}
            tone="up"
            icon={ArrowDownIcon}
          />
          <Stat label="Money out (mo)" value={fmtMoney(knownOutflow)} icon={ArrowUpIcon} />
        </div>

        <MonthMoneyLedger
          month={currentMonth}
          moneyIn={moneyIn}
          usePlannedIncome={usePlannedIncome}
          importedIncome={money.importedIncome}
          needs={planBuckets.needs}
          wants={planBuckets.wants}
          savings={savingsPosted}
          oneTime={oneTimeInCashOut}
          oneTimeCount={money.oneTimeCount}
          recurringNeeds={recurringByBucket.needs}
          recurringWants={recurringByBucket.wants}
          recurringSavings={recurringByBucket.savings}
          moneyOut={knownOutflow}
          left={cashFlow}
          savingsTarget={savingsTarget}
          savingsRemainingTarget={savingsRemainingTarget}
        />

        <SafeToSpendGuardrail result={hub.safeToSpend} />
      </div>

      <DataQualityCard hub={hub} today={today} />

      {/* Compact status chips — not a second full grid of cards */}
      <div className="grid gap-2 sm:grid-cols-3">
        <BillsHealthStrip
          paid={billsPaid}
          total={billsTotal}
          needsAttention={billsNeedingAttention}
        />
        <CashFlowStatusChip result={hub.cashFlowCalendar} />
        <EmergencyFundChip fund={emergencyFund} />
      </div>

      <CoachSuggestions items={adviceItems} today={today} flash={flash} loading={adviceLoading} />

      <div className="grid gap-4 lg:grid-cols-2">
        <SpendingWatchlistCard
          transactions={hub.transactions}
          month={today.slice(0, 7)}
          onChange={onChange}
          flash={flash}
        />
        <AccountsCard
          groups={accountGroups}
          total={accountsTotal}
          netWorth={hub.snapshot.netWorth}
          balanceSourceDate={balanceSourceDate}
          importedWithoutBalance={importedWithoutBalance}
          importedAccounts={importedAccounts}
          manageAccounts={manageAccounts}
          setManageAccounts={setManageAccounts}
          showAddAccount={showAddAccount}
          setShowAddAccount={setShowAddAccount}
          name={name}
          setName={setName}
          amount={amount}
          setAmount={setAmount}
          busy={busy}
          addAccount={addAccount}
          renderAccountRow={renderAccountRow}
          setEditingAccount={setEditingAccount}
          simplefinStatus={simplefinQuery.data}
          simplefinLoading={simplefinQuery.isLoading}
          onSimplefinChange={refreshFinanceData}
          flash={flash}
        />
      </div>
    </div>
  );
}

function MonthMoneyLedger({
  month,
  moneyIn,
  usePlannedIncome,
  importedIncome,
  needs,
  wants,
  savings,
  oneTime,
  oneTimeCount,
  recurringNeeds,
  recurringWants,
  recurringSavings,
  moneyOut,
  left,
  savingsTarget,
  savingsRemainingTarget,
}: {
  month: string;
  moneyIn: number;
  usePlannedIncome: boolean;
  importedIncome: number;
  needs: number;
  wants: number;
  savings: number;
  oneTime: number;
  oneTimeCount: number;
  recurringNeeds: number;
  recurringWants: number;
  recurringSavings: number;
  moneyOut: number;
  left: number;
  savingsTarget: number;
  savingsRemainingTarget: number;
}) {
  const [y, m] = month.split("-").map(Number);
  const monthLabel = new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  // Same bucket totals as Budget bars: statements + remaining unpaid recurring.
  const needsTotal = needs + recurringNeeds;
  const wantsTotal = wants + recurringWants;
  const savingsTotal = savings + recurringSavings;
  const planWithRecurring = needsTotal + wantsTotal + savingsTotal;

  return (
    <div className="zen-surface-nested space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            This month's money
          </div>
          <div className="text-sm font-medium">{monthLabel}</div>
        </div>
        <div className="text-right text-[11px] text-muted-foreground">
          In − out = left. Transfers between your accounts are not counted.
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-success">Money in</div>
          <LedgerLine
            label={usePlannedIncome ? "Take-home (Budget setting)" : "Imported income"}
            value={moneyIn}
            tone="in"
            strong
          />
          {usePlannedIncome && importedIncome > 0 && (
            <LedgerLine
              label="Imported deposits (not used as total)"
              value={importedIncome}
              muted
            />
          )}
        </div>

        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Money out</div>
          <LedgerLine
            label="Needs"
            value={needsTotal}
            note={
              recurringNeeds > 0
                ? `${fmtMoney(needs)} statements + ${fmtMoney(recurringNeeds)} unpaid`
                : undefined
            }
          />
          <LedgerLine
            label="Wants"
            value={wantsTotal}
            note={
              recurringWants > 0
                ? `${fmtMoney(wants)} statements + ${fmtMoney(recurringWants)} unpaid`
                : undefined
            }
          />
          <LedgerLine
            label="Savings contributions"
            value={savingsTotal}
            note={
              savingsTotal === 0
                ? "none tagged or scheduled yet"
                : recurringSavings > 0
                  ? `${fmtMoney(savings)} statements + ${fmtMoney(recurringSavings)} unpaid`
                  : undefined
            }
          />
          {oneTime > 0 && (
            <LedgerLine label={`One-time / out of plan (${oneTimeCount})`} value={oneTime} />
          )}
          <LedgerLine label="Money out total" value={moneyOut} strong />
        </div>
      </div>

      <div className="border-t border-border/50 pt-2">
        <LedgerLine
          label="Left after money out"
          value={left}
          tone={left >= 0 ? "in" : "out"}
          strong
          signed
        />
        <p className="mt-2 text-[11px] text-muted-foreground">
          Needs / wants / savings totals match Budget bars (statements + unpaid recurring ={" "}
          {fmtMoney(planWithRecurring)}). Money out also adds one-time charges ({fmtMoney(oneTime)}
          ), which Budget bars leave out of the plan.
          {savingsTarget > 0 && (
            <>
              {" "}
              Savings target is {fmtMoney(savingsTarget)}/mo; posted + scheduled savings are{" "}
              {fmtMoney(savingsTotal)}
              {savingsRemainingTarget > 0
                ? ` — ${fmtMoney(savingsRemainingTarget)} of the target is not in money out (only safe-to-spend reserves it).`
                : "."}
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function LedgerLine({
  label,
  value,
  tone,
  strong,
  muted,
  signed,
  note,
}: {
  label: string;
  value: number;
  tone?: "in" | "out";
  strong?: boolean;
  muted?: boolean;
  signed?: boolean;
  note?: string;
}) {
  if (muted && value === 0) return null;
  const display = signed ? `${value < 0 ? "-" : "+"}${fmtMoney(Math.abs(value))}` : fmtMoney(value);
  return (
    <div
      className={`flex items-center justify-between gap-3 text-sm ${
        strong ? "font-medium text-foreground" : "text-muted-foreground"
      }`}
    >
      <span className="min-w-0">
        {label}
        {note ? <span className="text-muted-foreground"> · {note}</span> : null}
      </span>
      <span
        className={`shrink-0 tabular-nums ${
          tone === "in"
            ? "text-success"
            : tone === "out"
              ? "text-destructive"
              : strong
                ? "text-foreground"
                : ""
        }`}
      >
        {display}
      </span>
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
        className="zen-surface-nested flex items-center gap-2.5 px-3 py-2.5 transition-colors hover:bg-muted/30"
      >
        <ReceiptIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Bills</div>
          <div className="text-sm text-muted-foreground">Add bills</div>
        </div>
        <CaretRightIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
      </Link>
    );
  }

  const warning = needsAttention > 0;
  return (
    <Link
      to="/finance/recurring"
      className="zen-surface-nested flex items-center gap-2.5 px-3 py-2.5 transition-colors hover:bg-muted/30"
    >
      <ReceiptIcon
        className={`size-4 shrink-0 ${warning ? "text-warning" : "text-success"}`}
        weight="duotone"
      />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Bills</div>
        <div className="text-sm">
          <span className="font-medium tabular-nums">
            {paid}/{total}
          </span>{" "}
          paid
          {needsAttention > 0 && (
            <span className="text-warning-foreground">
              {" · "}
              {needsAttention} alert{needsAttention === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>
      <CaretRightIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
    </Link>
  );
}

function SafeToSpendGuardrail({ result }: { result: FinanceHubPayload["safeToSpend"] }) {
  const statusMeta: Record<
    typeof result.status,
    { label: string; variant: "success" | "warning" | "destructive" | "secondary" }
  > = {
    unavailable: { label: "Setup", variant: "secondary" },
    "on-track": { label: "On track", variant: "success" },
    tight: { label: "Tight", variant: "warning" },
    "over-plan": { label: "Over plan", variant: "destructive" },
  };
  const meta = statusMeta[result.status];

  return (
    <div className="zen-surface-nested flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-warning/10 text-warning">
        <ShieldCheckIcon className="size-4" weight="duotone" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Safe to spend
          </span>
          <Badge variant={meta.variant} className="uppercase">
            {meta.label}
          </Badge>
        </div>
        {result.status === "unavailable" ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{result.explanation}</p>
        ) : (
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="text-xl font-semibold tabular-nums">
              {fmtMoney(result.safeToSpendThisMonth)}
            </span>
            <span className="text-sm tabular-nums text-muted-foreground">
              {fmtMoney(result.safeToSpendPerDay)}/day · {result.remainingDays}d left
            </span>
          </div>
        )}
      </div>
      {result.status !== "unavailable" && result.savingsReserve > 0 && (
        <p className="w-full text-[11px] text-muted-foreground sm:w-auto sm:max-w-xs sm:text-right">
          Reserves {fmtMoney(result.savingsReserve)} for remaining savings target — lower than “left
          after out.”
        </p>
      )}
    </div>
  );
}

function CashFlowStatusChip({ result }: { result: FinanceHubPayload["cashFlowCalendar"] }) {
  const statusMeta: Record<
    typeof result.status,
    { label: string; variant: "success" | "warning" | "destructive"; className: string }
  > = {
    healthy: { label: "Healthy", variant: "success", className: "text-success" },
    tight: { label: "Tight", variant: "warning", className: "text-warning" },
    negative: { label: "Below zero", variant: "destructive", className: "text-destructive" },
  };
  const meta = statusMeta[result.status];

  return (
    <Link
      to="/finance/recurring"
      className="zen-surface-nested flex items-center gap-2.5 px-3 py-2.5 transition-colors hover:bg-muted/30"
    >
      <ChartLineIcon className={`size-4 shrink-0 ${meta.className}`} weight="duotone" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            30-day floor
          </span>
          <Badge variant={meta.variant} className="h-4 px-1.5 text-[9px] uppercase">
            {meta.label}
          </Badge>
        </div>
        <div className="text-sm">
          <span className="font-medium tabular-nums">{fmtMoney(result.projectedFloor)}</span>
          <span className="text-muted-foreground"> · {fmtISODate(result.projectedFloorDate)}</span>
        </div>
      </div>
      <CaretRightIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
    </Link>
  );
}

function EmergencyFundChip({ fund }: { fund: EmergencyFundResult }) {
  const statusMeta: Record<
    typeof fund.status,
    { label: string; variant: "success" | "warning" | "secondary"; className: string }
  > = {
    "not-started": { label: "Build", variant: "secondary", className: "text-muted-foreground" },
    building: { label: "Building", variant: "warning", className: "text-warning" },
    funded: { label: "Funded", variant: "success", className: "text-success" },
    surplus: { label: "Surplus", variant: "success", className: "text-success" },
  };
  const meta = statusMeta[fund.status];

  return (
    <Link
      to="/finance/grow"
      className="zen-surface-nested flex items-center gap-2.5 px-3 py-2.5 transition-colors hover:bg-muted/30"
    >
      <PiggyBankIcon className={`size-4 shrink-0 ${meta.className}`} weight="duotone" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Emergency fund
          </span>
          <Badge variant={meta.variant} className="h-4 px-1.5 text-[9px] uppercase">
            {meta.label}
          </Badge>
        </div>
        <div className="text-sm">
          <span className="font-medium tabular-nums">{fund.monthsCovered.toFixed(1)} mo</span>
          <span className="text-muted-foreground"> covered</span>
        </div>
      </div>
      <CaretRightIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
    </Link>
  );
}

function AccountsCard({
  groups,
  total,
  netWorth,
  balanceSourceDate,
  importedWithoutBalance,
  importedAccounts,
  manageAccounts,
  setManageAccounts,
  showAddAccount,
  setShowAddAccount,
  name,
  setName,
  amount,
  setAmount,
  busy,
  addAccount,
  renderAccountRow,
  setEditingAccount,
  simplefinStatus,
  simplefinLoading,
  onSimplefinChange,
  flash,
}: {
  groups: {
    type: AccountType;
    label: string;
    Icon: typeof WalletIcon;
    rows: AccountBalance[];
    subtotal: number;
  }[];
  total: number;
  netWorth: number;
  balanceSourceDate: string | null;
  importedWithoutBalance: { account: string; count: number; lastSeen: number }[];
  importedAccounts: { account: string; count: number; lastSeen: number }[];
  manageAccounts: boolean;
  setManageAccounts: Dispatch<SetStateAction<boolean>>;
  showAddAccount: boolean;
  setShowAddAccount: Dispatch<SetStateAction<boolean>>;
  name: string;
  setName: Dispatch<SetStateAction<string>>;
  amount: string;
  setAmount: Dispatch<SetStateAction<string>>;
  busy: boolean;
  addAccount: (e: SyntheticEvent) => Promise<void>;
  renderAccountRow: (a: AccountBalance) => ReactNode;
  setEditingAccount: Dispatch<SetStateAction<string | null>>;
  simplefinStatus: Parameters<typeof SimplefinConnectionsCard>[0]["status"];
  simplefinLoading: boolean;
  onSimplefinChange: () => Promise<void>;
  flash: (msg: string, ms?: number) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 pb-2">
        <div>
          <CardTitle className="flex items-center gap-1.5 text-base">
            <WalletIcon className="size-4 text-muted-foreground" weight="duotone" />
            Accounts
          </CardTitle>
          {balanceSourceDate && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Balances from {fmtISODate(balanceSourceDate)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="text-right">
            <div
              className={`text-lg font-semibold tabular-nums ${total < 0 ? "text-destructive" : ""}`}
            >
              {fmtMoney(total)}
            </div>
            <div className="text-[11px] text-muted-foreground">accounts total</div>
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
      </CardHeader>
      <CardContent className="space-y-3">
        {groups.length === 0 ? (
          importedAccounts.length ? (
            <div className="zen-surface-nested px-3 py-2 text-xs text-muted-foreground">
              <div className="text-sm font-medium text-foreground">Imported statement accounts</div>
              <ul className="mt-1 space-y-1">
                {importedAccounts.map((a) => (
                  <li key={a.account} className="flex items-center justify-between gap-2">
                    <span>{a.account}</span>
                    <span className="shrink-0 tabular-nums">
                      {a.count} txn{a.count === 1 ? "" : "s"} · last {fmtDate(a.lastSeen)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px]">
                Use Manage to add current balances and build a net-worth baseline.
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No account balances yet. Tap Manage to add them.
            </p>
          )
        ) : (
          <div className="grid gap-2 sm:grid-cols-3">
            {groups.map(({ type, label, Icon, rows, subtotal }) => (
              <div key={type} className="zen-surface-nested px-3 py-2.5">
                <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <Icon className="size-3.5" weight="duotone" />
                  {label}
                </div>
                <div
                  className={`text-lg font-semibold tabular-nums ${
                    subtotal < 0 ? "text-destructive" : "text-success"
                  }`}
                >
                  {fmtMoney(subtotal)}
                </div>
                {manageAccounts ? (
                  <ul className="mt-1.5 space-y-1 text-xs">{rows.map(renderAccountRow)}</ul>
                ) : (
                  <ul className="mt-1.5 space-y-1 text-xs">
                    {rows.map((a) => (
                      <li key={a.account} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-muted-foreground">{a.account}</span>
                        <span
                          className={`shrink-0 tabular-nums ${
                            a.amount < 0 ? "text-destructive" : ""
                          }`}
                        >
                          {fmtMoney(a.amount)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}

        {Math.round(netWorth) !== Math.round(total) && groups.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            Net worth {fmtMoney(netWorth)} also counts {fmtMoney(netWorth - total)} of manual
            holdings on Investments. Synced holdings are already in account balances.
          </p>
        )}

        {importedWithoutBalance.length > 0 && (
          <div className="zen-surface-nested px-3 py-2 text-xs text-muted-foreground">
            <div className="font-medium text-foreground">Imported without balances</div>
            <ul className="mt-1 space-y-1">
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
              <form onSubmit={addAccount} className="flex items-center gap-2">
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
          </>
        )}

        <SimplefinConnectionsCard
          status={simplefinStatus}
          loading={simplefinLoading}
          onChange={onSimplefinChange}
          flash={flash}
          defaultOpen={false}
        />
      </CardContent>
    </Card>
  );
}

const ADVICE_META: Record<
  FinanceAdviceItem["category"],
  { label: string; Icon: typeof SparkleIcon }
> = {
  budget: { label: "Budget", Icon: PiggyBankIcon },
  subscriptions: { label: "Subscriptions", Icon: SparkleIcon },
  investing: { label: "Investing", Icon: SparkleIcon },
  earn: { label: "Earn more", Icon: SparkleIcon },
};

const FINANCE_HIGHLIGHT_RE = /(\$[\d,]+(?:\.\d+)?|\b\d+(?:\.\d+)?%?\b)/;

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
      <Card role="status" aria-busy="true" className="coach-accent overflow-hidden">
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
    <Card className="coach-accent overflow-hidden">
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

function SpendingWatchlistCard({
  transactions,
  month,
  onChange,
  flash,
}: {
  transactions: Transaction[];
  month: string;
  onChange: () => Promise<void>;
  flash: (msg: string, ms?: number) => void;
}) {
  const rows = useMemo(() => rollupWatchlistMonth(transactions, month), [transactions, month]);
  const total = rows.reduce((sum, row) => sum + row.spent, 0);
  const [openId, setOpenId] = useState<WatchlistId | null>(null);
  const [busy, setBusy] = useState(false);

  const openRow = rows.find((row) => row.id === openId);
  const openTxns = useMemo(() => {
    if (!openId) return [];
    return transactionsForMonth(transactions, month)
      .filter((t) => !t.deletedAt && t.watchlistId === openId && t.amount < 0)
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      .slice(0, 12);
  }, [openId, transactions, month]);

  async function reassign(txnId: string, watchlistId: WatchlistId | null) {
    setBusy(true);
    try {
      await setTransactionWatchlist({ data: { id: txnId, watchlistId, remember: true } });
      await onChange();
      flash(
        watchlistId
          ? `Moved to ${WATCHLIST_META[watchlistId].shortLabel}.`
          : "Removed from watchlist.",
      );
    } catch (err) {
      console.error(err);
      flash("Couldn’t update watchlist.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 pb-2">
        <div>
          <CardTitle className="flex items-center gap-1.5 text-base">
            <EyeIcon className="size-4 text-muted-foreground" weight="duotone" />
            Spending watchlist
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            This month’s problem areas only — not your full 50/30/20 plan. Auto-tagged from
            merchants; tap a row to correct.
          </p>
        </div>
        {total > 0 && (
          <div className="text-right">
            <div className="text-lg font-semibold tabular-nums">{fmtMoney(total)}</div>
            <div className="text-[11px] text-muted-foreground">tracked spend</div>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No watchlist spend yet this month. Groceries, dining, shopping, subscriptions, and
            coffee get tagged automatically as transactions land.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((row, index) => {
              const share = total > 0 ? Math.round((row.spent / total) * 100) : 0;
              const active = openId === row.id;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(active ? null : row.id)}
                    className={`flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                      active ? "bg-muted/40" : "hover:bg-muted/25"
                    }`}
                  >
                    <span className="w-4 shrink-0 text-center text-[11px] tabular-nums text-muted-foreground">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{row.label}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {share > 0 ? `${share}%` : ""}
                        </span>
                      </div>
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full bg-primary/70"
                          style={{ width: `${Math.max(share, 2)}%` }}
                          aria-hidden
                        />
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {row.count} charge{row.count === 1 ? "" : "s"}
                      </div>
                    </div>
                    <span className="shrink-0 self-start font-medium tabular-nums">
                      {fmtMoney(row.spent)}
                    </span>
                  </button>
                  {active && openRow && (
                    <ul className="mt-1 space-y-1 border-l-2 border-warning/30 pl-2.5">
                      {openTxns.map((t) => (
                        <li
                          key={t.id}
                          className="flex items-center justify-between gap-2 py-1 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium">{displayMerchant(t)}</div>
                            <TxnSubline t={t} className="text-[10px]" />
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <span className="tabular-nums text-destructive">
                              −{fmtMoney(Math.abs(t.amount))}
                            </span>
                            <WatchlistPicker
                              value={t.watchlistId}
                              disabled={busy}
                              onSelect={(id) => reassign(t.id, id)}
                            />
                          </div>
                        </li>
                      ))}
                      {openTxns.length === 0 && (
                        <li className="py-1 text-muted-foreground">No charges listed.</li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function WatchlistPicker({
  value,
  disabled,
  onSelect,
}: {
  value?: WatchlistId;
  disabled?: boolean;
  onSelect: (id: WatchlistId | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-6 px-1.5 text-[10px] text-muted-foreground"
        >
          {value ? WATCHLIST_META[value].shortLabel : "Tag"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-48 p-1">
        <div className="space-y-0.5">
          {WATCHLIST_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted ${
                value === id ? "bg-muted font-medium" : ""
              }`}
              onClick={() => {
                setOpen(false);
                onSelect(id);
              }}
            >
              <span>{WATCHLIST_META[id].shortLabel}</span>
              {value === id && <CheckIcon className="size-3.5" weight="bold" />}
            </button>
          ))}
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted"
            onClick={() => {
              setOpen(false);
              onSelect(null);
            }}
          >
            None
          </button>
        </div>
      </PopoverContent>
    </Popover>
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
