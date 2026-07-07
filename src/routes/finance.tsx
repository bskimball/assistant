import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Reveal, revealDelay } from "@/components/motion";
import {
  financeAdviceQuery,
  financeHubQuery,
  queryKeys,
  simplefinStatusQuery,
} from "@/lib/queries";
import {
  Wallet,
  PiggyBank,
  Repeat,
  TrendingUp,
  Lightbulb,
  Upload,
  Plus,
  RefreshCw,
  Check,
  X,
  CircleDollarSign,
  AlertTriangle,
  Sparkles,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Target,
  BriefcaseBusiness,
  CalendarCheck,
  Trash2,
  Landmark,
  Receipt,
  Pencil,
  Activity,
  CreditCard,
  Banknote,
  LineChart,
  Wallet2,
  Circle,
  CheckCircle2,
  ListChecks,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveDailyFinance } from "@/server/domain";
import {
  saveBudget,
  importTransactions,
  detectSubscriptions,
  saveSubscriptions,
  recategorizeTransaction,
  recategorizeAllTransactions,
  setTransactionExcluded,
  acceptFinanceActions,
  refreshQuotes,
  backfillSimplefinHistory,
  undoSimplefinHistory,
  connectSimplefin,
  disconnectSimplefin,
  saveSimplefinMappings,
  syncSimplefinNow,
  type FinanceHubPayload,
  type SimplefinStatusPayload,
} from "@/server/finance";
import {
  todayISO,
  subscriptionMonthlyCost,
  spendBucketOf,
  recurringKindOf,
  recurringBudgetBucket,
  isCuttableSubscription,
  loanPayoffMonths,
  cleanMerchantName,
  summarizeCashFlow,
  DEFAULT_BUDGET_TARGETS,
  type CategoryGroup,
  type RecurringKind,
  type Subscription,
  type Transaction,
  type Position,
  type AccountBalance,
  type FinanceAdviceItem,
} from "@/lib/domain";
import {
  buildCashFlowProjection,
  calculateEmergencyFund,
  recurringAdditionsForMonth,
  recurringAdditionsFromItems,
  recurringItemsForMonth,
  simulateDebtPayoff,
  transactionsForMonth,
  type BudgetBucket,
  type BudgetRecurringItem,
} from "@/lib/finance-math";

type TabKey = "overview" | "budget" | "recurring" | "investments" | "grow";

const TABS: { key: TabKey; label: string; Icon: typeof Wallet }[] = [
  { key: "overview", label: "Overview", Icon: Wallet },
  { key: "budget", label: "Budget", Icon: PiggyBank },
  { key: "recurring", label: "Recurring", Icon: Repeat },
  { key: "investments", label: "Investments", Icon: TrendingUp },
  { key: "grow", label: "Grow", Icon: Lightbulb },
];

const INSTITUTIONS = ["Bank of America", "M&T Bank", "Capital One", "Robinhood", "Other"];

export const Route = createFileRoute("/finance")({
  validateSearch: (search: Record<string, unknown>): { tab?: TabKey } => {
    const raw = typeof search.tab === "string" ? search.tab : undefined;
    // Old links used ?tab=subscriptions; keep them working under the new key.
    const normalized = raw === "subscriptions" ? "recurring" : raw;
    const valid = TABS.some((t) => t.key === normalized) ? (normalized as TabKey) : undefined;
    return { tab: valid };
  },
  loader: async ({ context: { queryClient } }) => {
    const date = todayISO();
    // Only block navigation on the hub data (cheap R2 reads). The AI advice
    // is a multi-second Grok call — kick it off now but let it resolve after
    // the page renders; the advice cards appear when it lands. Browser only:
    // during SSR a floating query would hold the response stream open.
    if (typeof window !== "undefined") {
      void queryClient.prefetchQuery(financeAdviceQuery(date));
    }
    await queryClient.ensureQueryData(financeHubQuery(date));
  },
  component: FinancePage,
});

function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

function moneyInputValue(n: number | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "";
}

function fmtDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function fmtISODate(date: string): string {
  return new Date(date + "T00:00:00").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// Month math on "YYYY-MM" keys. Uses local Date only for calendar arithmetic on
// the year/month integers (day pinned to 1), so there's no timezone day-shift.
function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

function isPaycheckLike(t: Transaction): boolean {
  const text = `${t.category || ""} ${t.notes || ""}`.toLowerCase();
  return ["payroll", "adp", "direct dep", "salary", "paycheck"].some((k) => text.includes(k));
}

type ImportedAccountSummary = {
  account: string;
  count: number;
  lastSeen: number;
};

function summarizeImportedAccounts(transactions: Transaction[]): ImportedAccountSummary[] {
  const map = new Map<string, ImportedAccountSummary>();
  for (const t of transactions) {
    const account = t.account?.trim();
    if (!account) continue;
    const key = account.toLowerCase();
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = Math.max(existing.lastSeen, t.timestamp);
    } else {
      map.set(key, { account, count: 1, lastSeen: t.timestamp });
    }
  }
  return [...map.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

function recurringAdditionsSummary(additions: Record<BudgetBucket, number>): string {
  return (["needs", "wants", "savings"] as const)
    .filter((bucket) => additions[bucket] > 0)
    .map((bucket) => `${bucket} ${fmtMoney(additions[bucket])}`)
    .join(", ");
}

function FinancePage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const tab: TabKey = search.tab || "overview";
  const today = todayISO();
  const month = today.slice(0, 7);

  // Primed by the route loader; revisits are served from cache (no refetch
  // flash) with a background refresh.
  const { data: hub = null, isPending: loading } = useQuery(financeHubQuery(today));
  const { data: advice = null } = useQuery(financeAdviceQuery(today));
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tabs call this after a mutation: invalidate → refetch the hub so every view
  // bound to it updates.
  const reload = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.financeHub(today) }),
    [queryClient, today],
  );

  function flash(msg: string, ms = 3500) {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    setStatus(msg);
    statusTimerRef.current = setTimeout(() => {
      setStatus(null);
      statusTimerRef.current = null;
    }, ms);
  }

  useEffect(
    () => () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    },
    [],
  );

  const netWorth = hub?.snapshot.netWorth ?? 0;

  return (
    <div className="bg-background px-4 pb-28 pt-8 sm:px-6 sm:pb-16">
      <div className="mx-auto w-full max-w-page">
        {/* Header */}
        <div className="mb-5">
          <div className="text-xs uppercase tracking-[2px] text-muted-foreground">Money</div>
          <div className="flex items-end justify-between gap-3">
            <div className="text-balance text-3xl font-semibold tracking-tighter">Finance Hub</div>
            <div className="rounded-xl bg-card px-3 py-2 text-right ring-1 ring-foreground/10">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Net worth
              </div>
              <div className="text-2xl font-semibold tabular-nums">{fmtMoney(netWorth)}</div>
            </div>
          </div>
        </div>

        {/* Tab bar */}
        <div className="mb-6 flex gap-1 overflow-x-auto rounded-lg bg-muted/50 p-1 ring-1 ring-foreground/10">
          {TABS.map(({ key, label, Icon }) => {
            const active = tab === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() =>
                  navigate({
                    search: { tab: key === "overview" ? undefined : key },
                  })
                }
                className={`flex h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded px-3 text-sm font-medium transition-[background-color,color,box-shadow,scale] duration-150 ease-out active:scale-[0.96] ${
                  active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="size-4" /> {label}
              </button>
            );
          })}
        </div>

        {status && (
          <div className="mb-4 rounded-lg bg-card px-3 py-2 text-sm text-muted-foreground ring-1 ring-foreground/10">
            {status}
          </div>
        )}

        {loading && !hub ? (
          <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
        ) : !hub ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            Couldn’t load your finances.
          </div>
        ) : (
          <Reveal key={tab}>
            {tab === "overview" && (
              <OverviewTab
                hub={hub}
                today={today}
                adviceItems={advice?.items ?? []}
                onChange={reload}
                flash={flash}
              />
            )}
            {tab === "budget" && (
              <BudgetTab hub={hub} month={month} onChange={reload} flash={flash} />
            )}
            {tab === "recurring" && <RecurringTab hub={hub} onChange={reload} flash={flash} />}
            {tab === "investments" && (
              <InvestmentsTab hub={hub} today={today} onChange={reload} flash={flash} />
            )}
            {tab === "grow" && <GrowTab hub={hub} today={today} flash={flash} />}
          </Reveal>
        )}
      </div>
    </div>
  );
}

type TabProps = {
  hub: FinanceHubPayload;
  onChange: () => Promise<void>;
  flash: (msg: string) => void;
};

/* ---------------- Overview ---------------- */

function OverviewTab({
  hub,
  today,
  adviceItems,
  onChange,
  flash,
}: TabProps & { today: string; adviceItems: FinanceAdviceItem[] }) {
  const queryClient = useQueryClient();
  const simplefinQuery = useQuery(simplefinStatusQuery());
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingAccount, setEditingAccount] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editCurrency, setEditCurrency] = useState("USD");
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
  const recurringAdditions = recurringAdditionsForMonth(hub.subscriptions, monthTxns);
  const plannedRecurring =
    recurringAdditions.needs + recurringAdditions.wants + recurringAdditions.savings;
  const knownOutflow = spend + plannedRecurring;
  const cashFlow = income - knownOutflow;
  const targets = hub.budget?.targets ?? DEFAULT_BUDGET_TARGETS;
  const monthlyNeedsFromStatements = monthTxns
    .filter((t) => spendBucketOf(t.categoryGroup) === "needs" && !t.excludeFromBudget)
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);
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
                className="inline-flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground"
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

      <OverviewAISuggestionsCard items={adviceItems} today={today} flash={flash} />

      {plannedRecurring > 0 && (
        <p className="-mt-1 text-xs text-muted-foreground">
          Includes {fmtMoney(plannedRecurring)} of active recurring commitments not seen in imported
          statements yet.
        </p>
      )}

      <DataQualityCard hub={hub} today={today} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            <span>Accounts</span>
            {balanceSourceDate && (
              <span className="text-xs font-normal text-muted-foreground">
                Balances from {fmtISODate(balanceSourceDate)}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {accounts.length ? (
            <>
              <div className="mb-3 space-y-3 text-sm">
                {accountGroups.map(({ type, label, Icon, rows, subtotal }) => (
                  <section key={type}>
                    <div className="mb-0.5 flex items-center justify-between gap-2 border-b border-border/60 pb-1">
                      <h3 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
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
                    {fmtMoney(hub.snapshot.netWorth - accountsTotal)} of holdings tracked on the
                    Investments tab.
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
              <Plus className="size-4" /> Save
            </Button>
          </form>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Add new balances below, or edit a saved row to rename an account, update its balance, or
            change its currency.
          </p>
        </CardContent>
      </Card>

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

function OverviewAISuggestionsCard({
  items,
  today,
  flash,
}: {
  items: FinanceAdviceItem[];
  today: string;
  flash: (msg: string) => void;
}) {
  const topItems = items.slice(0, 2);
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [acceptedItems, setAcceptedItems] = useState<Set<number>>(new Set());

  useEffect(() => {
    setAcceptedItems(new Set());
    setBusyIndex(null);
  }, [items]);

  if (!topItems.length) return null;

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
    <Card className="overflow-hidden border-primary/20 bg-linear-to-br from-primary/8 via-card to-card shadow-sm">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Sparkles className="size-4" />
            </span>
            AI suggestions
          </span>
          <Badge
            variant="secondary"
            className="bg-primary/10 text-[10px] uppercase tracking-wide text-primary"
          >
            Top moves
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 md:grid-cols-2">
          {topItems.map((item, index) => {
            const meta = ADVICE_META[item.category];
            const accepted = acceptedItems.has(index);
            return (
              <div
                key={`${item.category}-${index}`}
                className="rounded-lg bg-background/70 p-3 shadow-[0_1px_0_rgba(0,0,0,0.05)] ring-1 ring-foreground/10"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                  <div className="flex min-w-0 flex-1 gap-3">
                    <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <meta.Icon className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {meta.label}
                      </div>
                      <p className="mt-1 text-pretty text-sm leading-6">
                        {renderHighlightedAdvice(item.text)}
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={accepted ? "secondary" : "outline"}
                    onClick={() => acceptOne(item, index)}
                    disabled={busyIndex !== null || accepted}
                    className="h-9 shrink-0 gap-1.5 transition-[scale,background-color,color,box-shadow] active:scale-[0.96]"
                  >
                    <Check className="size-3.5" />
                    {accepted ? "Added" : "Add to tasks"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4 text-muted-foreground" />
          Transactions
        </CardTitle>
      </CardHeader>
      <CardContent>
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
            No transactions yet. Connect your bank below or import a CSV statement on the Budget
            tab.
          </p>
        )}
      </CardContent>
    </Card>
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

function SimplefinConnectionsCard({
  status,
  loading,
  onChange,
  flash,
}: {
  status?: SimplefinStatusPayload;
  loading: boolean;
  onChange: () => Promise<void>;
  flash: (msg: string) => void;
}) {
  const [setupToken, setSetupToken] = useState("");
  const [aliasDrafts, setAliasDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // Management rows (aliases, loan links, history imports, disconnect) live
  // behind a disclosure — the summary row + Sync now cover the daily need.
  const [expanded, setExpanded] = useState(false);
  const connected = !!status?.connected;
  const nextSyncAt = status?.manualSyncAvailableAt;
  const manualSyncBlocked = !!nextSyncAt && nextSyncAt > Date.now();

  async function connect(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!setupToken.trim()) return;
    setBusy(true);
    try {
      await connectSimplefin({ data: { setupToken } });
      setSetupToken("");
      await onChange();
      flash("SimpleFIN connected.");
    } catch (err: any) {
      console.error(err);
      flash(err?.message || "Couldn’t connect SimpleFIN.");
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    setBusy(true);
    try {
      const result = await syncSimplefinNow({ data: {} });
      await onChange();
      flash(result.message);
    } catch (err: any) {
      console.error(err);
      flash(err?.message || "Couldn’t sync SimpleFIN.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await disconnectSimplefin({ data: {} });
      await onChange();
      flash("SimpleFIN disconnected.");
    } catch (err: any) {
      console.error(err);
      flash(err?.message || "Couldn’t disconnect SimpleFIN.");
    } finally {
      setBusy(false);
    }
  }

  async function saveAlias(accountId: string, fallback: string) {
    const alias = (aliasDrafts[accountId] ?? fallback).trim();
    setBusy(true);
    try {
      await saveSimplefinMappings({ data: { aliases: { [accountId]: alias } } });
      await onChange();
      flash("Account alias saved.");
    } catch (err: any) {
      console.error(err);
      flash(err?.message || "Couldn’t save alias.");
    } finally {
      setBusy(false);
    }
  }

  async function backfillHistory(accountId: string) {
    setBusy(true);
    try {
      const result = await backfillSimplefinHistory({ data: { accountId } });
      await onChange();
      flash(result.message);
    } catch (err: any) {
      console.error(err);
      flash(err?.message || "Couldn’t import account history.");
    } finally {
      setBusy(false);
    }
  }

  async function undoHistory(accountId: string) {
    setBusy(true);
    try {
      const result = await undoSimplefinHistory({ data: { accountId } });
      await onChange();
      flash(result.message);
    } catch (err: any) {
      console.error(err);
      flash(err?.message || "Couldn’t undo the history import.");
    } finally {
      setBusy(false);
    }
  }

  async function linkLoan(accountId: string, subscriptionId: string) {
    setBusy(true);
    try {
      await saveSimplefinMappings({
        data: { loanLinks: { [accountId]: subscriptionId || null } },
      });
      await onChange();
      flash(subscriptionId ? "Loan link saved." : "Loan link removed.");
    } catch (err: any) {
      console.error(err);
      flash(err?.message || "Couldn’t save loan link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span>Bank connections</span>
          {connected && status?.lastSync && (
            <span className="text-xs font-normal text-muted-foreground">
              Last sync {fmtDate(status.lastSync.at)}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {status?.missingSealKey && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            SIMPLEFIN_SEAL_KEY is missing. Add a 32-byte base64 Workers secret before connecting.
          </div>
        )}

        {!connected ? (
          <form onSubmit={connect} className="space-y-2">
            <Label htmlFor="simplefin-token">SimpleFIN setup token</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="simplefin-token"
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                placeholder="Paste setup token"
                className="flex-1"
              />
              <Button type="submit" disabled={busy || loading || !setupToken.trim()}>
                Connect
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              The access URL is sealed on the server and never sent back to this page.
            </p>
          </form>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                Connected
              </span>
              {status?.accounts.length ? (
                <span className="text-xs text-muted-foreground">
                  {status.accounts.length} account{status.accounts.length === 1 ? "" : "s"}
                </span>
              ) : null}
              <span className="min-w-2 flex-1" />
              <Button
                type="button"
                size="sm"
                className="gap-1"
                onClick={syncNow}
                disabled={busy || loading || manualSyncBlocked}
                title={
                  manualSyncBlocked && nextSyncAt
                    ? `Available ${fmtDate(nextSyncAt)}`
                    : "Sync balances and transactions"
                }
              >
                <RefreshCw className="size-4" />
                Sync now
              </Button>
            </div>
            {status?.lastSync?.message && (
              <p className="text-xs text-muted-foreground">{status.lastSync.message}</p>
            )}

            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex w-full items-center justify-between rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
              aria-expanded={expanded}
            >
              <span>Manage accounts &amp; connection</span>
              <ChevronDown
                className={`size-4 transition-transform ${expanded ? "" : "-rotate-90"}`}
              />
            </button>

            {expanded && status?.accounts.length ? (
              <ul className="space-y-2">
                {status.accounts.map((account) => {
                  const stale =
                    account.balanceDate && Date.now() / 1000 - account.balanceDate > 48 * 60 * 60;
                  const aliasValue =
                    aliasDrafts[account.id] ?? status.aliases[account.id] ?? account.displayName;
                  return (
                    <li key={account.id} className="rounded-md border border-border/60 px-3 py-2">
                      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">
                            {account.orgName ? `${account.orgName} · ` : ""}
                            {account.name}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {fmtMoney(account.balance)} {account.currency}
                            {account.balanceDate
                              ? ` · as of ${fmtDate(account.balanceDate * 1000)}`
                              : ""}
                            {stale ? " · stale" : ""}
                          </div>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] lg:w-[24rem]">
                          <Input
                            value={aliasValue}
                            onChange={(e) =>
                              setAliasDrafts((drafts) => ({
                                ...drafts,
                                [account.id]: e.target.value,
                              }))
                            }
                            aria-label={`Alias for ${account.name}`}
                            className="h-8"
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => saveAlias(account.id, account.displayName)}
                            disabled={busy}
                          >
                            Save alias
                          </Button>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {status.accountCutovers[account.id] ? (
                          <>
                            <span className="text-[11px] text-muted-foreground">
                              History imported since {status.accountCutovers[account.id]}
                            </span>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-[11px]"
                              onClick={() => undoHistory(account.id)}
                              disabled={busy}
                            >
                              Undo
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => backfillHistory(account.id)}
                              disabled={busy}
                            >
                              Import 90-day history
                            </Button>
                            <span className="text-[11px] text-muted-foreground">
                              Feeds recurring-charge detection. Skip if you already CSV-imported
                              this account — it could double-count.
                            </span>
                          </>
                        )}
                      </div>
                      {status.loanOptions.length > 0 && (
                        <div className="mt-2 flex flex-col gap-1 sm:flex-row sm:items-center">
                          <Label className="text-xs text-muted-foreground">Loan link</Label>
                          <Select
                            value={status.loanLinks[account.id] || "none"}
                            onValueChange={(v) => linkLoan(account.id, v === "none" ? "" : v)}
                            disabled={busy}
                          >
                            <SelectTrigger aria-label="Loan link" className="h-8 w-full sm:w-auto">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                <SelectItem value="none">Not linked</SelectItem>
                                {status.loanOptions.map((loan) => (
                                  <SelectItem key={loan.id} value={loan.id}>
                                    {loan.name}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : expanded ? (
              <p className="text-sm text-muted-foreground">
                Connected. Run a sync to list accounts and write today’s finance snapshot.
              </p>
            ) : null}

            {expanded && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={disconnect}
                disabled={busy}
              >
                Disconnect
              </Button>
            )}
          </>
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
  const dotColor = score === 4 ? "bg-green-500" : score >= 2 ? "bg-amber-500" : "bg-destructive";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
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

function BudgetTab({ hub, month, onChange, flash }: TabProps & { month: string }) {
  const [takeHome, setTakeHome] = useState(moneyInputValue(hub.budget?.monthlyTakeHome));
  const [busy, setBusy] = useState(false);
  const [showStatements, setShowStatements] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [institution, setInstitution] = useState(INSTITUTIONS[0]);
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

  const targets = hub.budget?.targets ?? DEFAULT_BUDGET_TARGETS;
  const th = Number(takeHome) || hub.budget?.monthlyTakeHome || 0;

  const monthTxns = transactionsForMonth(hub.transactions, selectedMonth);
  // Per-bucket totals + the transactions behind each bar. One-time charges the
  // user has marked (excludeFromBudget) are kept in the lists but greyed out and
  // left out of the totals, so a single big legal/medical bill doesn't blow the
  // monthly 50/30/20 comparison.
  const buckets: Record<BudgetBucket, number> = { needs: 0, wants: 0, savings: 0 };
  const bucketTxns: Record<BudgetBucket, Transaction[]> = {
    needs: [],
    wants: [],
    savings: [],
  };
  let excludedTotal = 0;
  for (const t of monthTxns) {
    const b = moveOverrides[t.id] ?? spendBucketOf(t.categoryGroup);
    if (!b) continue;
    bucketTxns[b].push(t);
    if (t.excludeFromBudget) excludedTotal += Math.abs(t.amount);
    else buckets[b] += Math.abs(t.amount);
  }
  for (const b of ["needs", "wants", "savings"] as const) {
    bucketTxns[b].sort((a, c) => Math.abs(c.amount) - Math.abs(a.amount));
  }
  const statementBuckets = { ...buckets };

  async function toggleExclude(id: string, excluded: boolean) {
    await setTransactionExcluded({ data: { id, excluded } });
    await onChange();
    flash(excluded ? "Marked as one-time — left out of the plan." : "Back in the plan.");
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
  const recurringItems = recurringItemsForMonth(hub.subscriptions, monthTxns);
  const recurringAdditions = recurringAdditionsFromItems(recurringItems);
  for (const b of ["needs", "wants", "savings"] as const) {
    buckets[b] += recurringAdditions[b];
  }
  const plannedRecurring =
    recurringAdditions.needs + recurringAdditions.wants + recurringAdditions.savings;
  const statementActivity =
    statementBuckets.needs + statementBuckets.wants + statementBuckets.savings;
  const plannedActivity = statementActivity + plannedRecurring;
  const needsDelta = buckets.needs - th * targets.needs;
  const wantsDelta = buckets.wants - th * targets.wants;
  const savingsDelta = th * targets.savings - buckets.savings;
  const budgetAction =
    th <= 0
      ? null
      : needsDelta > 0
        ? `Needs are ${fmtMoney(needsDelta)} over plan. Open Needs first and verify bills, loan payments, and anything that should be marked one-time.`
        : wantsDelta > 0
          ? `Wants are ${fmtMoney(wantsDelta)} over plan. Open Wants and move miscategorized essentials or mark true one-time charges.`
          : savingsDelta > 0
            ? `Savings is ${fmtMoney(savingsDelta)} short of the monthly target. Add or verify an automatic transfer on the Recurring tab.`
            : "This month is on plan so far. Use the Recurring tab to verify every expected payment landed.";

  async function saveTakeHome() {
    const v = Number(takeHome);
    if (!Number.isFinite(v) || v <= 0) return;
    setBusy(true);
    try {
      await saveBudget({
        data: {
          budget: {
            monthlyTakeHome: v,
            targets: hub.budget?.targets ?? { ...DEFAULT_BUDGET_TARGETS },
            categoryLimits: hub.budget?.categoryLimits,
          },
        },
      });
      setTakeHome(moneyInputValue(v));
      await onChange();
      flash("Budget saved.");
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
                  onClick={saveTakeHome}
                  disabled={busy || !takeHome}
                  className="gap-1 transition-[scale,background-color,color,box-shadow] active:scale-[0.96]"
                >
                  <Check className="size-3.5" /> Save
                </Button>
              </div>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="-mt-1 text-xs text-muted-foreground">
            Spending here comes from your imported and synced transactions for{" "}
            {formatMonthLabel(selectedMonth)}, plus active recurring commitments from the Recurring
            tab that haven’t shown up in statements yet. Targets are 50/30/20 of the take-home
            baseline in this header.
          </p>
          {th > 0 ? (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <MiniStat label="Statement activity" value={fmtMoney(statementActivity)} />
                <MiniStat label="Planned recurring left" value={fmtMoney(plannedRecurring)} />
                <MiniStat
                  label="Plan total"
                  value={`${fmtMoney(plannedActivity)} / ${fmtMoney(th)}`}
                />
              </div>
              {budgetAction && (
                <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  {budgetAction}
                </div>
              )}
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
              {plannedRecurring > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Includes {fmtMoney(plannedRecurring)} of active recurring commitments not seen in
                  imported statements yet ({recurringAdditionsSummary(recurringAdditions)}). Manage
                  them on the Recurring tab.
                </p>
              )}
              {excludedTotal > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Excludes {fmtMoney(excludedTotal)} of one-time charges you’ve marked. Tap a bar to
                  see what’s in it.
                </p>
              )}
            </>
          ) : (
            <div className="text-sm text-muted-foreground">
              Set your take-home pay above to see your 50/30/20 breakdown.
            </div>
          )}
        </CardContent>
      </Card>

      <ExpenseSorter
        monthLabel={formatMonthLabel(selectedMonth)}
        bucketTxns={bucketTxns}
        onMove={moveToBucket}
        onToggleExclude={toggleExclude}
      />

      <button
        type="button"
        onClick={() => setShowStatements((v) => !v)}
        className="flex w-full items-center justify-between rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
        aria-expanded={showStatements}
      >
        <span>Import statement &amp; recent transactions</span>
        <ChevronDown
          className={`size-4 transition-transform ${showStatements ? "" : "-rotate-90"}`}
        />
      </button>

      {showStatements && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Import statement</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-sm text-muted-foreground">
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
                <Button
                  variant="ghost"
                  className="gap-1.5"
                  onClick={recategorizeAll}
                  disabled={busy}
                >
                  <RefreshCw className="size-4" /> Re-categorize all
                </Button>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Re-applies the latest rules to past transactions (e.g. tagging credit-card payments
                as transfers). Your manual changes are kept.
              </p>
            </CardContent>
          </Card>

          <RecentTransactions transactions={monthTxns} onChange={onChange} />
        </>
      )}
    </div>
  );
}

const GROUP_LABELS: Record<CategoryGroup, string> = {
  needs: "Needs",
  wants: "Wants",
  savings: "Savings",
  income: "Income",
  transfer: "Transfer",
};

function MonthNav({
  month,
  onPrev,
  onNext,
  canGoNext,
}: {
  month: string;
  onPrev: () => void;
  onNext: () => void;
  canGoNext: boolean;
}) {
  return (
    <div className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onPrev}
        aria-label="Previous month"
        title="Previous month"
        className="size-10 transition-[scale,background-color,color] active:scale-[0.96]"
      >
        <ChevronLeft className="size-4" />
      </Button>
      <span className="min-w-23 text-center tabular-nums">{formatMonthLabel(month)}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onNext}
        disabled={!canGoNext}
        aria-label="Next month"
        title={canGoNext ? "Next month" : "Already at the current month"}
        className="size-10 transition-[scale,background-color,color] active:scale-[0.96]"
      >
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}

/* ---------------- Expense sorter (drag & drop into 50/30/20) ---------------- */

const SORTER_BUCKETS: { key: BudgetBucket; label: string; accent: string }[] = [
  { key: "needs", label: "Needs", accent: "text-sky-600 dark:text-sky-400" },
  { key: "wants", label: "Wants", accent: "text-foreground" },
  { key: "savings", label: "Savings", accent: "text-emerald-600 dark:text-emerald-400" },
];

// Sum imported transactions only. Budget bars may also include recurring
// commitments that are not visible in statement data yet.
function bucketSum(txns: Transaction[]): number {
  return txns.reduce((s, t) => (t.excludeFromBudget ? s : s + Math.abs(t.amount)), 0);
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
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<BudgetBucket | null>(null);
  const [overBucket, setOverBucket] = useState<BudgetBucket | null>(null);
  const total = bucketTxns.needs.length + bucketTxns.wants.length + bucketTxns.savings.length;

  function handleDrop(target: BudgetBucket, e: React.DragEvent) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain") || dragId;
    setOverBucket(null);
    setDragId(null);
    setDragFrom(null);
    if (id && dragFrom !== target) onMove(id, target);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span>Categorize imported expenses</span>
          <span className="text-xs font-normal text-muted-foreground">
            Drag a card between buckets, or tap its Need / Want / Save chips
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <div className="rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-6 text-center text-sm text-muted-foreground">
            No categorized expenses for {monthLabel}. Step back with the arrows above to a month
            with imported statements, or import one below.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            {SORTER_BUCKETS.map(({ key, label, accent }) => {
              const txns = bucketTxns[key];
              const isOver = overBucket === key;
              return (
                <div
                  key={key}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (overBucket !== key) setOverBucket(key);
                  }}
                  onDragLeave={(e) => {
                    // Ignore leaves into child nodes; only clear when truly exiting.
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                      setOverBucket((b) => (b === key ? null : b));
                    }
                  }}
                  onDrop={(e) => handleDrop(key, e)}
                  className={`flex flex-col rounded-lg border p-2 transition-colors ${
                    isOver ? "border-primary bg-primary/5" : "border-border/60 bg-muted/10"
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between px-1">
                    <span className={`text-xs font-semibold uppercase tracking-wide ${accent}`}>
                      {label}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {fmtMoney(bucketSum(txns))} imported
                    </span>
                  </div>
                  {txns.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border/50 px-2 py-6 text-center text-[11px] text-muted-foreground">
                      Drop expenses here
                    </div>
                  ) : (
                    <ul className="max-h-96 space-y-1.5 overflow-y-auto pr-0.5">
                      {txns.map((t) => (
                        <ExpenseCard
                          key={t.id}
                          t={t}
                          bucket={key}
                          dragging={dragId === t.id}
                          onDragStart={(e) => {
                            e.dataTransfer.setData("text/plain", t.id);
                            e.dataTransfer.effectAllowed = "move";
                            setDragId(t.id);
                            setDragFrom(key);
                          }}
                          onDragEnd={() => {
                            setDragId(null);
                            setDragFrom(null);
                            setOverBucket(null);
                          }}
                          onMove={onMove}
                          onToggleExclude={onToggleExclude}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ExpenseCard({
  t,
  bucket,
  dragging,
  onDragStart,
  onDragEnd,
  onMove,
  onToggleExclude,
}: {
  t: Transaction;
  bucket: BudgetBucket;
  dragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onMove: (id: string, group: BudgetBucket) => void | Promise<void>;
  onToggleExclude: (id: string, excluded: boolean) => void | Promise<void>;
}) {
  const excluded = !!t.excludeFromBudget;
  return (
    <li
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`cursor-grab rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs active:cursor-grabbing ${
        dragging ? "opacity-40" : ""
      }`}
    >
      <div className="flex items-center gap-1.5">
        <GripVertical className="size-3.5 shrink-0 text-muted-foreground" />
        <div className={`min-w-0 flex-1 ${excluded ? "opacity-50" : ""}`}>
          <div className={`truncate ${excluded ? "line-through" : ""}`}>
            {t.category ? cleanMerchantName(t.category) : "—"}
          </div>
          <TxnSubline t={t} />
        </div>
        <span
          className={`shrink-0 tabular-nums ${excluded ? "text-muted-foreground line-through" : ""}`}
        >
          {fmtMoney(Math.abs(t.amount))}
        </span>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <GroupPicker value={bucket} onChange={(g) => onMove(t.id, g)} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onToggleExclude(t.id, !excluded)}
          className="h-auto shrink-0 px-1.5 py-0.5 text-[10px] text-muted-foreground"
          title={excluded ? "Count this in the plan again" : "Mark as a one-time charge"}
        >
          {excluded ? "Include" : "One-time"}
        </Button>
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

const CADENCE_ABBR: Record<Subscription["cadence"], string> = {
  weekly: "wk",
  monthly: "mo",
  annual: "yr",
};

function recurringKindLabel(kind: RecurringKind): string {
  return kind === "loan" ? "Loan" : kind === "bill" ? "Bill" : "Subscription";
}

/* ---------------- Subscriptions ---------------- */

// The three spendable 50/30/20 buckets a recurring item can land in. Unset
// subscriptions are treated as "wants" for backward compatibility.
type SpendGroup = "needs" | "wants" | "savings";

function groupOf(s: Pick<Subscription, "group">): SpendGroup {
  return s.group === "needs" || s.group === "savings" ? s.group : "wants";
}

const GROUP_OPTIONS: { key: SpendGroup; label: string; activeClass: string }[] = [
  {
    key: "needs",
    label: "Need",
    activeClass: "bg-background text-sky-600 shadow-sm dark:text-sky-400",
  },
  {
    key: "wants",
    label: "Want",
    activeClass: "bg-background text-foreground shadow-sm",
  },
  {
    key: "savings",
    label: "Save",
    activeClass: "bg-background text-emerald-600 shadow-sm dark:text-emerald-400",
  },
];

function GroupPicker({
  value,
  onChange,
  disabled,
}: {
  value: SpendGroup;
  onChange: (g: SpendGroup) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Spending category"
      className="inline-flex shrink-0 rounded-lg bg-muted/40 p-1 ring-1 ring-foreground/10"
    >
      {GROUP_OPTIONS.map((o) => {
        const active = value === o.key;
        return (
          <button
            key={o.key}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(o.key)}
            className={`h-10 rounded px-2.5 text-xs font-medium transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96] disabled:opacity-50 ${
              active ? o.activeClass : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// The kind of obligation controls which section a row lives in. The budget
// bucket is separate: loans are always Needs, bills can be Needs or Wants, and
// subscriptions can be Wants or recurring Savings.
const KIND_OPTIONS: { key: RecurringKind; label: string; activeClass: string }[] = [
  {
    key: "loan",
    label: "Loan",
    activeClass: "bg-background text-amber-600 shadow-sm dark:text-amber-400",
  },
  {
    key: "bill",
    label: "Bill",
    activeClass: "bg-background text-sky-600 shadow-sm dark:text-sky-400",
  },
  {
    key: "subscription",
    label: "Sub",
    activeClass: "bg-background text-foreground shadow-sm",
  },
];

function KindPicker({
  value,
  onChange,
  disabled,
}: {
  value: RecurringKind;
  onChange: (k: RecurringKind) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Obligation type"
      className="inline-flex shrink-0 rounded-lg bg-muted/40 p-1 ring-1 ring-foreground/10"
    >
      {KIND_OPTIONS.map((o) => {
        const active = value === o.key;
        return (
          <button
            key={o.key}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(o.key)}
            className={`h-10 rounded px-2.5 text-xs font-medium transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96] disabled:opacity-50 ${
              active ? o.activeClass : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function NeedWantPicker({
  value,
  onChange,
  disabled,
}: {
  value: "needs" | "wants";
  onChange: (g: "needs" | "wants") => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Need or want"
      className="inline-flex shrink-0 rounded-lg bg-muted/40 p-1 ring-1 ring-foreground/10"
    >
      {(["needs", "wants"] as const).map((g) => {
        const active = value === g;
        return (
          <button
            key={g}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(g)}
            className={`h-10 rounded px-2.5 text-xs font-medium transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96] disabled:opacity-50 ${
              active
                ? g === "needs"
                  ? "bg-background text-sky-600 shadow-sm dark:text-sky-400"
                  : "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {g === "needs" ? "Need" : "Want"}
          </button>
        );
      })}
    </div>
  );
}

// A two-way Want/Save toggle for subscriptions.
function SaveWantPicker({
  value,
  onChange,
  disabled,
}: {
  value: "wants" | "savings";
  onChange: (g: "wants" | "savings") => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Wants or savings"
      className="inline-flex shrink-0 rounded-lg bg-muted/40 p-1 ring-1 ring-foreground/10"
    >
      {(["wants", "savings"] as const).map((g) => {
        const active = value === g;
        return (
          <button
            key={g}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(g)}
            className={`h-10 rounded px-2.5 text-xs font-medium transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96] disabled:opacity-50 ${
              active
                ? g === "savings"
                  ? "bg-background text-emerald-600 shadow-sm dark:text-emerald-400"
                  : "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {g === "savings" ? "Save" : "Want"}
          </button>
        );
      })}
    </div>
  );
}

function formatPayoff(months: number): string {
  if (months < 18) return `~${months} mo left`;
  const years = Math.round(months / 12);
  return `~${years} yr left`;
}

function RecurringRow({
  s,
  chargeStatus,
  onChangeKind,
  onChangeGroup,
  onToggleCancel,
  onSaveEdit,
}: {
  s: Subscription;
  chargeStatus?: string;
  onChangeKind: (s: Subscription, k: RecurringKind) => void;
  onChangeGroup: (s: Subscription, g: SpendGroup) => void;
  onToggleCancel: (s: Subscription) => void;
  onSaveEdit: (s: Subscription, patch: Partial<Subscription>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(s.name);
  const [editAmount, setEditAmount] = useState(String(s.amount));
  const [editCadence, setEditCadence] = useState<Subscription["cadence"]>(s.cadence);
  const [editBalance, setEditBalance] = useState(s.balance != null ? String(s.balance) : "");
  const [editApr, setEditApr] = useState(s.apr != null ? String(s.apr) : "");
  const kind = recurringKindOf(s);
  const canceled = s.status === "canceled";
  const monthly = subscriptionMonthlyCost(s);

  function startEdit() {
    setEditName(s.name);
    setEditAmount(String(s.amount));
    setEditCadence(s.cadence);
    setEditBalance(s.balance != null ? String(s.balance) : "");
    setEditApr(s.apr != null ? String(s.apr) : "");
    setEditing(true);
  }

  function saveEdit() {
    const amt = Number(editAmount);
    if (!editName.trim() || !Number.isFinite(amt) || amt <= 0) return;
    onSaveEdit(s, {
      name: editName.trim(),
      amount: amt,
      cadence: editCadence,
      ...(kind === "loan"
        ? { balance: Number(editBalance) || undefined, apr: Number(editApr) || undefined }
        : {}),
    });
    setEditing(false);
  }

  if (editing) {
    return (
      <li className="space-y-2 py-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            aria-label="Name"
            className="h-8 min-w-35 flex-1"
          />
          <Input
            type="number"
            step="0.01"
            value={editAmount}
            onChange={(e) => setEditAmount(e.target.value)}
            aria-label="Amount"
            className="h-8 w-24"
          />
          <Select
            value={editCadence}
            onValueChange={(v) => setEditCadence(v as Subscription["cadence"])}
          >
            <SelectTrigger aria-label="Cadence" className="h-8 w-auto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="annual">Annual</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        {kind === "loan" && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              step="0.01"
              value={editBalance}
              onChange={(e) => setEditBalance(e.target.value)}
              placeholder="Balance (optional)"
              aria-label="Loan balance"
              className="h-8 w-36"
            />
            <Input
              type="number"
              step="0.01"
              value={editApr}
              onChange={(e) => setEditApr(e.target.value)}
              placeholder="APR % (optional)"
              aria-label="Loan APR"
              className="h-8 w-32"
            />
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={saveEdit}
            disabled={!editName.trim() || !editAmount || Number(editAmount) <= 0}
          >
            <Check className="size-3.5" /> Save
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs text-muted-foreground"
            onClick={() => setEditing(false)}
          >
            <X className="size-3.5" /> Cancel
          </Button>
        </div>
      </li>
    );
  }
  const payoff = kind === "loan" ? loanPayoffMonths(s.balance, s.apr, monthly) : null;
  const loanMeta =
    kind === "loan"
      ? [
          s.balance ? `${fmtMoney(s.balance)} balance` : null,
          s.apr ? `${s.apr}% APR` : null,
          payoff ? formatPayoff(payoff) : null,
        ].filter(Boolean)
      : [];
  const subGroup = groupOf(s) === "savings" ? "savings" : "wants";
  const billGroup = groupOf(s) === "wants" ? "wants" : "needs";
  return (
    <li className="py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1 basis-52">
          <div className="flex items-baseline justify-between gap-2">
            <span className={`truncate ${canceled ? "line-through opacity-60" : ""}`}>
              {cleanMerchantName(s.name)}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {fmtMoney(monthly)}/mo
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {s.cadence !== "monthly" ? `${fmtMoney(s.amount)}/${CADENCE_ABBR[s.cadence]} · ` : ""}
            {s.source === "detected" ? "Detected from statements" : "Added manually"}
            {chargeStatus && !canceled && (
              <span className="text-emerald-600 dark:text-emerald-400"> · {chargeStatus}</span>
            )}
          </div>
          {loanMeta.length > 0 && (
            <div className="text-[11px] tabular-nums text-muted-foreground">
              {loanMeta.join(" · ")}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {!canceled && (
            <>
              <KindPicker value={kind} onChange={(k) => onChangeKind(s, k)} />
              {kind === "bill" && (
                <NeedWantPicker value={billGroup} onChange={(g) => onChangeGroup(s, g)} />
              )}
              {kind === "subscription" && (
                <SaveWantPicker value={subGroup} onChange={(g) => onChangeGroup(s, g)} />
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs text-muted-foreground"
                onClick={startEdit}
                aria-label={`Edit ${cleanMerchantName(s.name)}`}
              >
                <Pencil className="size-3.5" /> Edit
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs text-muted-foreground"
            onClick={() => onToggleCancel(s)}
          >
            {canceled ? (
              <>
                <Check className="size-3.5" /> Reactivate
              </>
            ) : (
              <>
                <X className="size-3.5" /> Cancel
              </>
            )}
          </Button>
        </div>
      </div>
    </li>
  );
}

const SECTION_META: {
  kind: RecurringKind;
  label: string;
  hint: string;
  Icon: typeof Landmark;
}[] = [
  { kind: "loan", label: "Loans", hint: "Needs", Icon: Landmark },
  { kind: "bill", label: "Bills", hint: "Needs/Wants", Icon: Receipt },
  { kind: "subscription", label: "Subscriptions & savings", hint: "Wants/Savings", Icon: Repeat },
];

// One verification row: matched charge (green check + paid detail) or an
// unmatched item (muted circle + why it may be missing).
function PaymentCheckRow({ item }: { item: BudgetRecurringItem }) {
  const isAnnual = item.cadence === "annual";
  const seenCount =
    item.expectedThisMonth > 0
      ? Math.min(item.matchedCount, item.expectedThisMonth)
      : item.matchedCount;
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        {item.seenThisMonth ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
        ) : (
          <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />
        )}
        <div className="min-w-0">
          <div className="truncate">{cleanMerchantName(item.name)}</div>
          {item.seenThisMonth && item.matchedTxn ? (
            <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-emerald-700 dark:text-emerald-400">
              <span>
                {item.expectedThisMonth > 1
                  ? `${seenCount} of ${item.expectedThisMonth} seen; latest`
                  : "Paid"}
              </span>
              <span className="tabular-nums">{fmtDate(item.matchedTxn.timestamp)}</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{fmtMoney(Math.abs(item.matchedTxn.amount))}</span>
              {item.matchedTxn.account ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="truncate">{item.matchedTxn.account}</span>
                </>
              ) : null}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              {isAnnual
                ? "Annual - excluded from monthly check"
                : item.expectedThisMonth > 1
                  ? `0 of ${item.expectedThisMonth} weekly charges seen this month`
                  : "Not seen in statements this month"}
            </div>
          )}
        </div>
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        ~{fmtMoney(item.monthlyAmount)}/mo
      </span>
    </li>
  );
}

// Reconciles active recurring commitments against a month's statements so the
// owner can confirm every expected payment actually landed. Annual items are
// listed but never counted as missing. Defaults to the current month; the
// month nav steps back to completed months, where verification is meaningful.
function MonthlyPaymentCheckCard({
  subscriptions,
  transactions,
}: {
  subscriptions: Subscription[];
  transactions: Transaction[];
}) {
  const currentMonth = todayISO().slice(0, 7);
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const isCurrentMonth = selectedMonth === currentMonth;
  const monthLabel = formatMonthLabel(selectedMonth);
  const monthTxns = transactionsForMonth(transactions, selectedMonth);
  const hasMonthTxns = monthTxns.length > 0;
  const monthItems = recurringItemsForMonth(subscriptions, monthTxns);
  const items = (["needs", "wants", "savings"] as const).flatMap((bucket) => monthItems[bucket]);
  const verifiableItems = items.filter((i) => i.bucket !== "savings");
  const savingsItems = items.filter((i) => i.bucket === "savings");

  // Expected = cash outflow charges due monthly-or-more-often; annual items and
  // recurring savings transfers don't count as missing bill payments.
  const expected = verifiableItems.filter((i) => i.expectedThisMonth > 0);
  const total = expected.reduce((sum, i) => sum + i.expectedThisMonth, 0);
  const seen = expected.reduce((sum, i) => sum + Math.min(i.matchedCount, i.expectedThisMonth), 0);
  const allClear = total > 0 && expected.every((i) => i.matchedCount >= i.expectedThisMonth);
  const pct = total > 0 ? Math.round((seen / total) * 100) : 0;
  const pendingAmount = expected.reduce((sum, item) => {
    const missing = Math.max(0, item.expectedThisMonth - item.matchedCount);
    const perPayment = item.expectedThisMonth > 0 ? item.monthlyAmount / item.expectedThisMonth : 0;
    return sum + missing * perPayment;
  }, 0);
  // Early in the current month most payments simply haven't posted yet, so an
  // incomplete checklist isn't a red flag — nudge toward a completed month.
  const earlyInMonth = isCurrentMonth && Number(todayISO().slice(8, 10)) <= 10;

  // Unmatched first (they need attention), then matched; biggest monthly first.
  const ordered = [...verifiableItems].sort((a, b) => {
    const aComplete = a.expectedThisMonth > 0 && a.matchedCount >= a.expectedThisMonth;
    const bComplete = b.expectedThisMonth > 0 && b.matchedCount >= b.expectedThisMonth;
    if (aComplete !== bComplete) return aComplete ? 1 : -1;
    return b.monthlyAmount - a.monthlyAmount;
  });

  // All-clear collapses the (all-matched) list; otherwise the checklist is
  // open. A manual toggle only overrides until the month changes.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? !allClear;
  const pendingItems = ordered.filter(
    (item) => item.expectedThisMonth > 0 && item.matchedCount < item.expectedThisMonth,
  );
  const matchedItems = ordered.filter(
    (item) => !(item.expectedThisMonth > 0 && item.matchedCount < item.expectedThisMonth),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <ListChecks className="size-4 text-muted-foreground" />
            Monthly payment check
          </span>
          <MonthNav
            month={selectedMonth}
            onPrev={() => {
              setSelectedMonth((m) => shiftMonth(m, -1));
              setUserOpen(null);
            }}
            onNext={() => {
              setSelectedMonth((m) => shiftMonth(m, 1));
              setUserOpen(null);
            }}
            canGoNext={!isCurrentMonth}
          />
        </CardTitle>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="text-sm text-muted-foreground">
            No monthly or weekly bill payments to verify yet. Add loans, bills, or subscriptions
            below; recurring savings stays in Budget but does not count as a missing payment.
          </p>
        ) : (
          <>
            <div className="mb-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span
                  className={
                    allClear
                      ? "flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400"
                      : "font-medium"
                  }
                >
                  {allClear && <CheckCircle2 className="size-4" />}
                  {allClear
                    ? `All ${total} monthly payment${total === 1 ? "" : "s"} accounted for`
                    : `${seen} of ${total} payments seen in ${monthLabel} statements`}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {seen}/{total}
                  {!allClear && pendingAmount > 0
                    ? ` · ~${fmtMoney(pendingAmount)} still to post`
                    : ""}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-[width] duration-300 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>
              {earlyInMonth && !allClear && (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  It’s early in {monthLabel} — most payments haven’t posted yet. Step back a month
                  to verify a completed month.
                </p>
              )}
            </div>

            {allClear && (
              <button
                type="button"
                onClick={() => setUserOpen(!open)}
                className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                aria-expanded={open}
              >
                <ChevronDown
                  className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
                />
                {open ? "Hide" : "Show"} matched payments
              </button>
            )}

            {open && (
              <div className="mt-2 space-y-3">
                {pendingItems.length > 0 && (
                  <section>
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Still expected
                    </div>
                    <ul className="divide-y divide-border rounded-lg bg-muted/20 px-2 ring-1 ring-foreground/10">
                      {pendingItems.map((item) => (
                        <PaymentCheckRow key={item.id} item={item} />
                      ))}
                    </ul>
                  </section>
                )}
                {matchedItems.length > 0 && (
                  <section>
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Matched
                    </div>
                    <ul className="divide-y divide-border/60 rounded-lg px-2 ring-1 ring-foreground/10">
                      {matchedItems.map((item) => (
                        <PaymentCheckRow key={item.id} item={item} />
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}
          </>
        )}

        {savingsItems.length > 0 && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            Recurring savings and investing transfers are tracked in the Budget savings bucket, but
            they are excluded from this bill-payment count.
          </p>
        )}

        {!hasMonthTxns ? (
          <p className="mt-3 text-[11px] text-muted-foreground">
            No transactions imported for {monthLabel} yet — verification needs statement data. Sync
            your bank on the Overview tab or import a statement on the Budget tab.
          </p>
        ) : (
          seen < total && (
            <p className="mt-3 text-[11px] text-muted-foreground">
              Matching compares each item’s name and approximate amount to statement lines. If a
              payment was made but shows unmatched, edit the item so its name matches how it appears
              on your statement (e.g. “Delmarva Power”, not “Electric”) or update its amount.
            </p>
          )
        )}
      </CardContent>
    </Card>
  );
}

function DebtPayoffComparisonCard({ loans }: { loans: Subscription[] }) {
  const [extraPayment, setExtraPayment] = useState("0");
  const extra = Math.max(0, Number(extraPayment) || 0);
  const debts = loans
    .map((loan) => ({
      id: loan.id,
      name: cleanMerchantName(loan.name),
      balance: loan.balance ?? 0,
      apr: loan.apr,
      minimumPayment: subscriptionMonthlyCost(loan),
    }))
    .filter((loan) => loan.balance > 0 && loan.minimumPayment > 0);
  const missingCount = loans.length - debts.length;
  const snowball = debts.length
    ? simulateDebtPayoff({
        debts,
        extraMonthlyPayment: extra,
        strategy: "snowball",
      })
    : null;
  const avalanche = debts.length
    ? simulateDebtPayoff({
        debts,
        extraMonthlyPayment: extra,
        strategy: "avalanche",
      })
    : null;
  const interestDelta =
    snowball?.feasible && avalanche?.feasible
      ? snowball.totalInterest - avalanche.totalInterest
      : 0;
  const monthDelta =
    snowball && avalanche && snowball.months !== null && avalanche.months !== null
      ? snowball.months - avalanche.months
      : 0;

  return (
    <Card className="border-amber-500/20 bg-linear-to-br from-amber-500/6 to-card">
      <CardHeader>
        <CardTitle className="flex flex-col gap-3 text-base sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-2">
            <Landmark className="size-4 text-amber-600 dark:text-amber-400" />
            Debt payoff comparison
          </span>
          <div className="flex items-center gap-2">
            <Label
              htmlFor="extra-debt-payment"
              className="text-xs font-normal text-muted-foreground"
            >
              Extra monthly
            </Label>
            <Input
              id="extra-debt-payment"
              type="number"
              min="0"
              step="25"
              value={extraPayment}
              onChange={(e) => setExtraPayment(e.target.value)}
              className="h-9 w-28 text-right tabular-nums"
            />
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {debts.length ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {snowball && <DebtStrategySummary label="Snowball" simulation={snowball} />}
              {avalanche && <DebtStrategySummary label="Avalanche" simulation={avalanche} />}
            </div>
            <div className="rounded-lg bg-muted/25 px-3 py-2 text-xs text-muted-foreground ring-1 ring-foreground/10">
              {snowball?.feasible && avalanche?.feasible ? (
                <>
                  Avalanche saves{" "}
                  <span className="font-medium tabular-nums text-foreground">
                    {fmtMoney(Math.max(0, interestDelta))}
                  </span>{" "}
                  in interest
                  {monthDelta !== 0 ? (
                    <>
                      {" "}
                      and finishes{" "}
                      <span className="font-medium tabular-nums text-foreground">
                        {Math.abs(monthDelta)} mo {monthDelta > 0 ? "sooner" : "later"}
                      </span>
                    </>
                  ) : null}
                  . Snowball prioritizes the smallest balance first for faster visible wins.
                </>
              ) : (
                "At least one payoff plan is not feasible with the current minimum payments. Add extra payment or check APR/payment values."
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Add balances and payment amounts to active loans to compare snowball and avalanche
            payoff plans.
          </p>
        )}
        {missingCount > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {missingCount} active loan{missingCount === 1 ? "" : "s"} missing balance or payment
            data were left out of the simulation.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function DebtStrategySummary({
  label,
  simulation,
}: {
  label: string;
  simulation: ReturnType<typeof simulateDebtPayoff>;
}) {
  return (
    <div className="rounded-lg bg-muted/25 p-3 ring-1 ring-foreground/10">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">{label}</div>
        <Badge variant={simulation.feasible ? "secondary" : "outline"} className="text-[10px]">
          {simulation.feasible ? "Feasible" : "Check payments"}
        </Badge>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <MiniStat label="Payoff" value={formatPayoffMonths(simulation.months)} />
        <MiniStat label="Interest" value={fmtMoney(simulation.totalInterest)} />
      </div>
      <div className="mt-3 text-[11px] text-muted-foreground">
        First target:{" "}
        <span className="font-medium text-foreground">
          {simulation.payoffOrder[0]
            ? simulation.debts.find((debt) => debt.id === simulation.payoffOrder[0])?.name
            : "Highest priority loan"}
        </span>
      </div>
    </div>
  );
}

function formatPayoffMonths(months: number | null): string {
  if (months === null) return "Not feasible";
  if (months <= 0) return "Ready";
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (!years) return `${rest} mo`;
  return rest ? `${years}y ${rest}mo` : `${years}y`;
}

function RecurringTab({ hub, onChange, flash }: TabProps) {
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<Subscription[] | null>(null);
  const [kind, setKind] = useState<RecurringKind>("bill");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<Subscription["cadence"]>("monthly");
  const [group, setGroup] = useState<SpendGroup>("needs");
  const [balance, setBalance] = useState("");
  const [apr, setApr] = useState("");

  // One list of every recurring commitment; a row's kind decides its section, so
  // reclassifying it re-sorts in place. Active first, then biggest monthly first.
  const subs = [...hub.subscriptions].sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return subscriptionMonthlyCost(b) - subscriptionMonthlyCost(a);
  });
  const byKind = (k: RecurringKind) => subs.filter((s) => recurringKindOf(s) === k);
  const active = subs.filter((s) => s.status === "active");
  const activeLoans = active.filter((s) => recurringKindOf(s) === "loan");
  const monthlyOf = (k: RecurringKind) =>
    active
      .filter((s) => recurringKindOf(s) === k)
      .reduce((sum, s) => sum + subscriptionMonthlyCost(s), 0);
  const loansMonthly = monthlyOf("loan");
  const billsMonthly = monthlyOf("bill");
  const obligationsMonthly = loansMonthly + billsMonthly;
  const cuttableSubscriptionsMonthly = active
    .filter(isCuttableSubscription)
    .reduce((sum, s) => sum + subscriptionMonthlyCost(s), 0);
  const recurringSavingsMonthly = active
    .filter((s) => recurringBudgetBucket(s) === "savings")
    .reduce((sum, s) => sum + subscriptionMonthlyCost(s), 0);

  // Which items already matched a charge in this month's transactions, so rows
  // can say "charged this month" (same reconciliation the Budget tab uses).
  const currentMonthTxns = transactionsForMonth(hub.transactions, todayISO().slice(0, 7));
  const monthItems = recurringItemsForMonth(hub.subscriptions, currentMonthTxns);
  const chargeStatusById = new Map(
    (["needs", "wants", "savings"] as const)
      .flatMap((bucket) => monthItems[bucket])
      .filter((item) => item.seenThisMonth)
      .map((item) => [
        item.id,
        item.expectedThisMonth > 1
          ? `${Math.min(item.matchedCount, item.expectedThisMonth)} of ${
              item.expectedThisMonth
            } charges seen this month`
          : "charged this month",
      ]),
  );

  async function detect() {
    setBusy(true);
    flash("Scanning your transactions…");
    try {
      const res = await detectSubscriptions({ data: {} });
      setCandidates(res.candidates);
      flash(
        res.candidates.length
          ? `Found ${res.candidates.length} recurring charge(s) — set the type and add.`
          : "No new recurring charges detected. Import statements for better detection.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function persist(next: Subscription[]) {
    await saveSubscriptions({ data: { subscriptions: next } });
    await onChange();
  }

  async function confirmCandidate(c: Subscription) {
    await persist([...hub.subscriptions, c]);
    setCandidates((cs) => (cs ? cs.filter((x) => x.id !== c.id) : cs));
    flash(`Added ${cleanMerchantName(c.name)}.`);
  }

  async function toggleCancel(s: Subscription) {
    const next = hub.subscriptions.map((x) =>
      x.id === s.id
        ? {
            ...x,
            status: x.status === "active" ? ("canceled" as const) : ("active" as const),
          }
        : x,
    );
    await persist(next);
  }

  // Reclassifying keeps the budget bucket where it still makes sense. Loans are
  // always Needs; bills keep Need/Want; subscriptions keep Want/Save.
  async function changeKind(s: Subscription, nextKind: RecurringKind) {
    if (recurringKindOf(s) === nextKind) return;
    const currentGroup = groupOf(s);
    const nextGroup: CategoryGroup =
      nextKind === "loan"
        ? "needs"
        : nextKind === "bill"
          ? currentGroup === "wants"
            ? "wants"
            : "needs"
          : currentGroup === "savings"
            ? "savings"
            : "wants";
    await persist(
      hub.subscriptions.map((x) =>
        x.id === s.id ? { ...x, kind: nextKind, group: nextGroup } : x,
      ),
    );
    flash(
      `${cleanMerchantName(s.name)} → ${SECTION_META.find((m) => m.kind === nextKind)!.label}.`,
    );
  }

  async function saveEdit(s: Subscription, patch: Partial<Subscription>) {
    await persist(hub.subscriptions.map((x) => (x.id === s.id ? { ...x, ...patch } : x)));
    flash(`Updated ${cleanMerchantName(patch.name ?? s.name)}.`);
  }

  async function changeGroup(s: Subscription, next: SpendGroup) {
    if (groupOf(s) === next) return;
    await persist(hub.subscriptions.map((x) => (x.id === s.id ? { ...x, group: next } : x)));
    flash(`${cleanMerchantName(s.name)} marked as ${GROUP_LABELS[next]}.`);
  }

  function setCandidateKind(c: Subscription, nextKind: RecurringKind) {
    const currentGroup = groupOf(c);
    const nextGroup: CategoryGroup =
      nextKind === "loan"
        ? "needs"
        : nextKind === "bill"
          ? currentGroup === "wants"
            ? "wants"
            : "needs"
          : currentGroup === "savings"
            ? "savings"
            : "wants";
    setCandidates((cs) =>
      cs ? cs.map((x) => (x.id === c.id ? { ...x, kind: nextKind, group: nextGroup } : x)) : cs,
    );
  }

  function changeManualKind(nextKind: RecurringKind) {
    setKind(nextKind);
    setGroup((currentGroup) =>
      nextKind === "loan"
        ? "needs"
        : nextKind === "bill"
          ? currentGroup === "wants"
            ? "wants"
            : "needs"
          : currentGroup === "savings"
            ? "savings"
            : "wants",
    );
  }

  async function addManual(e: React.SyntheticEvent) {
    e.preventDefault();
    const amt = Number(amount);
    if (!name.trim() || !Number.isFinite(amt) || amt <= 0) return;
    const sub: Subscription = {
      id: `sub-${Date.now()}`,
      createdAt: Date.now(),
      name: name.trim(),
      amount: amt,
      cadence,
      status: "active",
      source: "manual",
      kind,
      group:
        kind === "loan"
          ? "needs"
          : kind === "bill"
            ? group === "wants"
              ? "wants"
              : "needs"
            : group === "savings"
              ? "savings"
              : "wants",
      ...(kind === "loan"
        ? { balance: Number(balance) || undefined, apr: Number(apr) || undefined }
        : {}),
    };
    await persist([...hub.subscriptions, sub]);
    setName("");
    setAmount("");
    setBalance("");
    setApr("");
    setGroup(kind === "subscription" ? "wants" : "needs");
    flash(`Added to ${SECTION_META.find((m) => m.kind === kind)!.label}.`);
  }

  const amountLabel = kind === "subscription" ? "Amount" : "Payment";
  const namePlaceholder =
    kind === "loan"
      ? "Name (e.g. Mortgage)"
      : kind === "bill"
        ? "Name (e.g. Electric)"
        : "Name (e.g. Netflix)";

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Loans & bills (mo)" value={fmtMoney(obligationsMonthly)} />
        <Stat label="Subscriptions (mo)" value={fmtMoney(cuttableSubscriptionsMonthly)} />
        <Stat
          label="Recurring savings (mo)"
          value={fmtMoney(recurringSavingsMonthly)}
          tone={recurringSavingsMonthly > 0 ? undefined : "warn"}
        />
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">
        Loans &amp; bills are fixed Needs that flow into your Budget; subscriptions are cuttable
        Wants; recurring savings is money kept, not spend.
      </p>

      <MonthlyPaymentCheckCard subscriptions={hub.subscriptions} transactions={hub.transactions} />

      {activeLoans.length > 0 && <DebtPayoffComparisonCard loans={activeLoans} />}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span>Recurring commitments</span>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={detect}
              disabled={busy}
            >
              {busy ? (
                <RefreshCw className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              Detect
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {subs.length ? (
            <div className="space-y-5">
              {SECTION_META.map(({ kind: k, label, hint, Icon }) => {
                const rows = byKind(k);
                const sectionMonthly = monthlyOf(k);
                return (
                  <section key={k}>
                    <div className="mb-1 flex items-center justify-between">
                      <h3 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        <Icon className="size-3.5" />
                        {label} · {hint}
                      </h3>
                      {rows.length > 0 && (
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {fmtMoney(sectionMonthly)}/mo
                        </span>
                      )}
                    </div>
                    {rows.length ? (
                      <ul className="divide-y divide-border">
                        {rows.map((s) => (
                          <RecurringRow
                            key={s.id}
                            s={s}
                            chargeStatus={chargeStatusById.get(s.id)}
                            onChangeKind={changeKind}
                            onChangeGroup={changeGroup}
                            onToggleCancel={toggleCancel}
                            onSaveEdit={saveEdit}
                          />
                        ))}
                      </ul>
                    ) : (
                      <p className="py-2 text-xs text-muted-foreground">
                        {k === "loan"
                          ? "No loans tracked. Add a mortgage, car, or student loan below."
                          : k === "bill"
                            ? "No bills yet — add utilities, insurance, rent, or phone below."
                            : "No subscriptions yet — detect them or add one below."}
                      </p>
                    )}
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              Nothing tracked yet. Detect recurring charges from imported statements or add a loan,
              bill, or subscription below.
            </div>
          )}
        </CardContent>
      </Card>

      {candidates && candidates.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Detected — set the type &amp; add</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {candidates.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{cleanMerchantName(c.name)}</div>
                    <div className="text-xs text-muted-foreground">
                      ~{fmtMoney(c.amount)}/
                      {c.cadence === "monthly" ? "mo" : c.cadence === "annual" ? "yr" : "wk"}
                    </div>
                  </div>
                  <KindPicker value={recurringKindOf(c)} onChange={(k) => setCandidateKind(c, k)} />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1"
                    onClick={() => confirmCandidate(c)}
                  >
                    <Plus className="size-3.5" /> Add
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add manually</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={addManual} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <KindPicker value={kind} onChange={changeManualKind} />
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={namePlaceholder}
                className="min-w-35 flex-1"
              />
              <Input
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={amountLabel}
                aria-label={amountLabel}
                className="w-28"
              />
              <Select
                value={cadence}
                onValueChange={(v) => setCadence(v as Subscription["cadence"])}
              >
                <SelectTrigger aria-label="Cadence" className="w-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="annual">Annual</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              {kind === "bill" && (
                <NeedWantPicker value={group === "wants" ? "wants" : "needs"} onChange={setGroup} />
              )}
              {kind === "subscription" && (
                <SaveWantPicker
                  value={group === "savings" ? "savings" : "wants"}
                  onChange={setGroup}
                />
              )}
              <Button type="submit" size="sm" className="gap-1" disabled={!name.trim() || !amount}>
                <Plus className="size-4" /> Add
              </Button>
            </div>
            {kind === "loan" && (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="number"
                  step="0.01"
                  value={balance}
                  onChange={(e) => setBalance(e.target.value)}
                  placeholder="Balance (optional)"
                  aria-label="Loan balance"
                  className="w-40"
                />
                <Input
                  type="number"
                  step="0.01"
                  value={apr}
                  onChange={(e) => setApr(e.target.value)}
                  placeholder="APR % (optional)"
                  aria-label="Loan APR"
                  className="w-36"
                />
                <span className="text-[11px] text-muted-foreground">
                  Balance + APR give a payoff estimate.
                </span>
              </div>
            )}
          </form>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Loans &amp; Bills are essential Needs and flow into your Budget automatically each
            month. Subscriptions are discretionary (Want) or a recurring Save. Switch a row's type
            anytime to move it between sections.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/* ---------------- Investments ---------------- */

function InvestmentsTab({ hub, today, onChange, flash }: TabProps & { today: string }) {
  const [symbol, setSymbol] = useState("");
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [liveSymbols, setLiveSymbols] = useState<Set<string>>(new Set());

  const positions = hub.snapshot.positions || [];
  const total = positions.reduce((s, p) => s + (p.value || 0), 0);
  const sortedPositions = [...positions].sort((a, b) => (b.value || 0) - (a.value || 0));
  const topHolding = sortedPositions[0];
  const allocationPct = (p: Position) =>
    total > 0 ? Math.round(((p.value || 0) / total) * 100) : 0;

  async function refreshPrices() {
    if (!positions.length) return;
    setRefreshing(true);
    try {
      const { prices, asOf: ts } = await refreshQuotes({
        data: { symbols: positions.map((p) => p.symbol) },
      });
      // Resolved symbols get the live close; everything else (a 401K balance,
      // a typo, a delisted name) keeps its last manual price.
      const updated = positions.map((p) => {
        const live = prices[p.symbol.toUpperCase()];
        if (!Number.isFinite(live)) return p;
        return {
          ...p,
          price: live,
          value: Math.round(p.quantity * live * 100) / 100,
        };
      });
      const hits = Object.keys(prices).length;
      if (hits) {
        await saveDailyFinance({
          data: {
            date: today,
            finance: {
              date: today,
              accounts: hub.snapshot.accounts || [],
              positions: updated,
            },
          },
        });
        await onChange();
      }
      setLiveSymbols(new Set(Object.keys(prices)));
      setAsOf(ts);
      const missed = positions.length - hits;
      flash(
        hits
          ? `Updated ${hits} price${hits === 1 ? "" : "s"}.${missed ? ` ${missed} kept manual.` : ""}`
          : "No live prices found — kept manual prices.",
      );
    } finally {
      setRefreshing(false);
    }
  }

  async function addPosition(e: React.SyntheticEvent) {
    e.preventDefault();
    const q = Number(qty);
    const pr = Number(price);
    if (!symbol.trim() || !Number.isFinite(q) || !Number.isFinite(pr)) return;
    setBusy(true);
    try {
      const next: Position[] = [...positions];
      const idx = next.findIndex((p) => p.symbol.toLowerCase() === symbol.trim().toLowerCase());
      const pos: Position = {
        symbol: symbol.trim().toUpperCase(),
        quantity: q,
        price: pr,
        value: Math.round(q * pr * 100) / 100,
      };
      if (idx >= 0) next[idx] = pos;
      else next.push(pos);
      await saveDailyFinance({
        data: {
          date: today,
          finance: {
            date: today,
            accounts: hub.snapshot.accounts || [],
            positions: next,
          },
        },
      });
      setSymbol("");
      setQty("");
      setPrice("");
      await onChange();
      flash("Holding saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Holdings value" value={fmtMoney(total)} hero />
        <Stat label="Positions" value={String(positions.length)} />
        <Stat
          label="Top holding"
          value={topHolding ? `${topHolding.symbol} · ${allocationPct(topHolding)}%` : "—"}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-base">Holdings</CardTitle>
            {asOf && (
              <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                Prices as of {new Date(asOf).toLocaleTimeString()}
              </p>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0 gap-1 whitespace-nowrap transition-[scale,background-color,color,box-shadow] active:scale-[0.96]"
            disabled={refreshing || !positions.length}
            onClick={refreshPrices}
          >
            <RefreshCw className={`size-4${refreshing ? " animate-spin" : ""}`} />
            {refreshing ? "Refreshing…" : "Refresh prices"}
          </Button>
        </CardHeader>
        <CardContent>
          {positions.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-120 text-sm">
                <thead>
                  <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="py-1.5 pr-2 text-left font-medium">Symbol</th>
                    <th className="px-2 py-1.5 text-right font-medium">Qty</th>
                    <th className="px-2 py-1.5 text-right font-medium">Price</th>
                    <th className="px-2 py-1.5 text-right font-medium">Value</th>
                    <th className="w-48 py-1.5 pl-2 text-right font-medium">Allocation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {sortedPositions.map((p) => {
                    const pct = allocationPct(p);
                    const isLive = liveSymbols.has(p.symbol.toUpperCase());
                    return (
                      <tr key={p.symbol}>
                        <td className="py-2 pr-2">
                          <span className="flex items-center gap-1.5 font-medium">
                            {p.symbol}
                            {isLive && (
                              <Badge
                                variant="secondary"
                                className="gap-1 bg-emerald-500/10 text-[10px] uppercase tracking-wide text-emerald-600 dark:text-emerald-400"
                              >
                                <span className="size-1.5 rounded-full bg-emerald-500" />
                                Live
                              </Badge>
                            )}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                          {p.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                          {fmtMoney(p.price)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {fmtMoney(p.value || 0)}
                        </td>
                        <td className="py-2 pl-2">
                          <div className="relative ml-auto h-8 w-full min-w-36 overflow-hidden rounded-lg bg-muted/60">
                            <span
                              className="absolute inset-y-0 left-0 rounded-lg bg-primary/25 transition-[width] duration-300 ease-out"
                              style={{ width: `${pct}%` }}
                              aria-hidden
                            />
                            <span className="relative flex h-full items-center justify-end px-2 text-xs font-medium tabular-nums text-foreground">
                              {pct}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              No holdings yet. Brokerage positions (Robinhood) arrive automatically with each
              SimpleFIN sync; add anything else manually (e.g. your ADP 401k balance as symbol
              “401K”).
            </div>
          )}
          <form onSubmit={addPosition} className="mt-4 flex flex-wrap items-center gap-2">
            <Input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="Symbol"
              className="w-28"
              disabled={busy}
            />
            <Input
              type="number"
              step="any"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="Qty"
              className="w-24"
              disabled={busy}
            />
            <Input
              type="number"
              step="any"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="Price"
              className="w-28"
              disabled={busy}
            />
            <Button type="submit" size="sm" className="gap-1" disabled={busy || !symbol.trim()}>
              <Plus className="size-4" /> Save
            </Button>
          </form>
        </CardContent>
      </Card>

      <Disclaimer />
    </div>
  );
}

/* ---------------- Grow (AI advisor) ---------------- */

const ADVICE_META: Record<
  FinanceAdviceItem["category"],
  { label: string; Icon: typeof Lightbulb }
> = {
  budget: { label: "Budget", Icon: PiggyBank },
  subscriptions: { label: "Subscriptions", Icon: Repeat },
  investing: { label: "Investing", Icon: TrendingUp },
  earn: { label: "Earn more", Icon: CircleDollarSign },
};

const FINANCE_HIGHLIGHT_RE = /(\$[\d,]+(?:\.\d+)?|\b\d+(?:\.\d+)?%?\b)/;

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

function GrowTab({
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
      <RevenueGrowthCard hub={hub} today={today} />
      <CashFlowProjectionCard hub={hub} today={today} />

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

      {items && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="size-4 text-primary" /> Recommended moves
              </CardTitle>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>
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
        </>
      )}

      <Disclaimer />
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
  const buckets: Record<BudgetBucket, number> = { needs: 0, wants: 0, savings: 0 };
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
        <div className="grid gap-3 sm:grid-cols-3">
          <MiniStat label="Starting cash" value={fmtMoney(cashOnHand)} />
          <MiniStat
            label="Projected net"
            value={`${projection.totalNetCashFlow < 0 ? "-" : "+"}${fmtMoney(Math.abs(projection.totalNetCashFlow))}`}
          />
          <MiniStat label="Ending cash" value={fmtMoney(projection.endingCash)} />
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
        <p className="text-pretty text-xs text-muted-foreground">
          Projection uses the current take-home baseline when set, the higher of budget targets or
          current run-rate buckets, and active recurring commitments already folded into those
          buckets.
        </p>
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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Target className="size-4 text-primary" /> Revenue growth target
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
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
        <p className="text-xs text-muted-foreground">
          The target is based on the current savings gap when available; otherwise it starts with a
          small monthly income experiment so the plan has a number to beat.
        </p>
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/* ---------------- Shared bits ---------------- */

type AccountType = "cash" | "credit" | "investments" | "other";

const ACCOUNT_GROUP_META: { type: AccountType; label: string; Icon: typeof Wallet2 }[] = [
  { type: "cash", label: "Cash", Icon: Wallet2 },
  { type: "credit", label: "Credit", Icon: CreditCard },
  { type: "investments", label: "Investments", Icon: LineChart },
  { type: "other", label: "Other", Icon: Banknote },
];

// Bucket an account by a case-insensitive keyword match on its name/alias.
function inferAccountType(name: string): AccountType {
  const s = name.toLowerCase();
  if (/(checking|savings|bank)/.test(s)) return "cash";
  if (/(credit|card|platinum)/.test(s)) return "credit";
  if (/(robinhood|stock|crypto|bitcoin|401k|brokerage|ira)/.test(s)) return "investments";
  return "other";
}

function cashLikeBalance(accounts: AccountBalance[]): number {
  return accounts
    .filter((account) => inferAccountType(account.account) === "cash" && account.amount > 0)
    .reduce((sum, account) => sum + account.amount, 0);
}

const SOURCE_BADGE_META: Record<
  NonNullable<Transaction["source"]>,
  { label: string; className: string }
> = {
  sync: {
    label: "Synced",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  import: {
    label: "CSV",
    className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  manual: {
    label: "Manual",
    className: "border-border bg-muted/40 text-muted-foreground",
  },
};

// Tiny provenance chip: where a transaction came from (bank sync, CSV, manual).
function SourceBadge({ source }: { source?: Transaction["source"] }) {
  const meta = SOURCE_BADGE_META[source ?? "manual"];
  return (
    <span
      className={`inline-flex h-4 items-center rounded border px-1 text-[9px] font-medium uppercase leading-none tracking-wide ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

const GROUP_CHIP_CLASS: Record<CategoryGroup, string> = {
  needs: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  wants: "border-border bg-muted/50 text-muted-foreground",
  savings: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  income: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  transfer: "border-border bg-muted/50 text-muted-foreground",
};

// 50/30/20 bucket chip shown on activity rows when a group is assigned.
function GroupChip({ group }: { group: CategoryGroup }) {
  return (
    <span
      className={`inline-flex h-4 items-center rounded border px-1 text-[9px] font-medium uppercase leading-none tracking-wide ${GROUP_CHIP_CLASS[group]}`}
    >
      {GROUP_LABELS[group]}
    </span>
  );
}

// Shared "date · account · source" sub-line so every transaction row identifies
// where it came from.
function TxnSubline({
  t,
  className,
  hideAccount,
}: {
  t: Transaction;
  className?: string;
  hideAccount?: boolean;
}) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground ${className ?? ""}`}
    >
      <span className="tabular-nums">{fmtDate(t.timestamp)}</span>
      {t.account && !hideAccount ? (
        <>
          <span aria-hidden>·</span>
          <span className="truncate">{t.account}</span>
        </>
      ) : null}
      <SourceBadge source={t.source} />
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  hero,
}: {
  label: string;
  value: string;
  tone?: "up" | "down" | "warn";
  hero?: boolean;
}) {
  return (
    <Card className={hero ? "border-primary/40 bg-primary/3" : undefined}>
      <CardContent className="pt-4">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div
          className={`mt-1 font-semibold tabular-nums ${hero ? "text-3xl" : "text-2xl"} ${
            tone === "up"
              ? "text-green-600 dark:text-green-500"
              : tone === "down"
                ? "text-destructive"
                : tone === "warn"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-foreground"
          }`}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function BudgetBar({
  label,
  actual,
  recurringPlanned = 0,
  target,
  targetPct,
  goal = "spend",
  txns = [],
  recurringItems = [],
  onToggleExclude,
}: {
  label: string;
  actual: number;
  /** Portion of `actual` that is planned recurring not yet seen in statements. */
  recurringPlanned?: number;
  target: number;
  targetPct: number;
  goal?: "spend" | "save";
  txns?: Transaction[];
  recurringItems?: BudgetRecurringItem[];
  onToggleExclude?: (id: string, excluded: boolean) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const statementActual = Math.max(0, actual - recurringPlanned);
  const ratio = target > 0 ? actual / target : 0;
  const pct = Math.min(100, Math.round(ratio * 100));
  const statementPct = target > 0 ? Math.min(100, Math.round((statementActual / target) * 100)) : 0;
  const plannedPct = Math.max(0, pct - statementPct);
  const remaining = target - actual;

  // Three-state color tuned to the goal direction. For spend buckets (needs/
  // wants) lower is better; for savings, hitting/exceeding the target is the win.
  const state: "good" | "warn" | "bad" =
    goal === "save"
      ? ratio >= 1
        ? "good"
        : "warn"
      : ratio > 1.02
        ? "bad"
        : ratio >= 0.9
          ? "warn"
          : "good";
  const barColor =
    state === "bad" ? "bg-destructive" : state === "warn" ? "bg-amber-500" : "bg-emerald-500";
  const plannedBarColor =
    state === "bad"
      ? "bg-destructive/35"
      : state === "warn"
        ? "bg-amber-500/35"
        : "bg-emerald-500/35";
  const emptyTrack = goal === "save" && actual <= 0;

  // Plain-language status so the eye lands on the number that matters.
  const note =
    goal === "save"
      ? remaining > 0
        ? `${fmtMoney(remaining)} to goal`
        : "goal met"
      : remaining >= 0
        ? `${fmtMoney(remaining)} left`
        : `${fmtMoney(-remaining)} over`;
  const noteColor = state === "bad" ? "text-destructive" : "text-muted-foreground";
  const recurringEstimate = recurringItems.reduce(
    (sum, item) => sum + item.remainingMonthlyAmount,
    0,
  );
  const expandable = (txns.length > 0 && !!onToggleExclude) || recurringItems.length > 0;
  return (
    <div>
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        disabled={!expandable}
        className="block w-full text-left disabled:cursor-default"
        aria-expanded={expandable ? open : undefined}
      >
        <div className="mb-1 flex items-center justify-between text-sm">
          <span className="flex items-center gap-1 capitalize">
            {expandable && (
              <ChevronDown
                className={`size-3.5 text-muted-foreground transition-transform ${
                  open ? "" : "-rotate-90"
                }`}
              />
            )}
            {label} <span className="text-xs text-muted-foreground">({targetPct}%)</span>
          </span>
          <span className="tabular-nums text-muted-foreground">
            {fmtMoney(actual)} / {fmtMoney(target)}
          </span>
        </div>
        <div className="relative h-3 w-full overflow-hidden rounded-full bg-muted">
          {emptyTrack && (
            <span
              className="absolute inset-0 bg-[radial-gradient(circle_at_center,var(--muted-foreground)_1px,transparent_1.5px)] bg-size-[8px_8px] opacity-25"
              aria-hidden
            />
          )}
          <div
            className={`absolute inset-y-0 left-0 transition-[width] duration-300 ease-out ${barColor}`}
            style={{ width: `${statementPct}%` }}
          />
          {plannedPct > 0 && (
            <div
              className={`absolute inset-y-0 transition-[left,width] duration-300 ease-out ${plannedBarColor} bg-[linear-gradient(135deg,rgba(255,255,255,.28)_25%,transparent_25%,transparent_50%,rgba(255,255,255,.28)_50%,rgba(255,255,255,.28)_75%,transparent_75%,transparent)] bg-size-[8px_8px]`}
              style={{ left: `${statementPct}%`, width: `${plannedPct}%` }}
            />
          )}
          <span className="absolute inset-y-0 right-0 w-px bg-foreground/40" aria-hidden />
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-xs tabular-nums">
          <span className="text-muted-foreground">
            {fmtMoney(statementActual)} from statements
            {recurringPlanned > 0 ? ` + ${fmtMoney(recurringPlanned)} planned recurring` : ""}
          </span>
          <span className={noteColor}>{note}</span>
        </div>
      </button>
      {open && expandable && (
        <ul className="mt-2 divide-y divide-border rounded-md border border-border/60 bg-muted/20">
          {recurringItems.length > 0 && (
            <li className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs font-medium">
              <div className="min-w-0 flex-1">
                <div className="truncate">Monthly recurring plan</div>
                <div className="text-muted-foreground">
                  {recurringEstimate > 0
                    ? `${fmtMoney(recurringEstimate)} not seen in statements yet`
                    : "All planned items already appear in statements"}
                </div>
              </div>
            </li>
          )}
          {recurringItems.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate">{cleanMerchantName(item.name)}</div>
                <div className="truncate text-muted-foreground">
                  {recurringKindLabel(item.kind)} · {CADENCE_ABBR[item.cadence]}
                  {item.account ? ` · ${item.account}` : ""}
                  {item.remainingMonthlyAmount > 0
                    ? ` · ${fmtMoney(item.remainingMonthlyAmount)} planned`
                    : " · covered by statements"}
                </div>
              </div>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {fmtMoney(item.monthlyAmount)}/mo
              </span>
            </li>
          ))}
          {txns.map((t) => {
            const excluded = !!t.excludeFromBudget;
            return (
              <li
                key={t.id}
                className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs"
              >
                <div className={`min-w-0 flex-1 ${excluded ? "opacity-50" : ""}`}>
                  <div className={`truncate ${excluded ? "line-through" : ""}`}>
                    {t.category ? cleanMerchantName(t.category) : "—"}
                  </div>
                  <TxnSubline t={t} />
                </div>
                <span
                  className={`shrink-0 tabular-nums ${excluded ? "text-muted-foreground line-through" : ""}`}
                >
                  {fmtMoney(Math.abs(t.amount))}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onToggleExclude?.(t.id, !excluded)}
                  className="h-auto shrink-0 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  title={excluded ? "Count this in the plan again" : "Mark as a one-time charge"}
                >
                  {excluded ? "Include" : "One-time"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Disclaimer() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>
        Educational guidance, not licensed financial advice. This app never moves money or executes
        trades on your behalf.
      </span>
    </div>
  );
}
