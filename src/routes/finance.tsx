import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from "react";
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
  Link2,
  Info,
  type LucideIcon,
} from "lucide-react";
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
import { saveDailyFinance } from "@/server/domain";
import {
  saveBudget,
  importTransactions,
  detectSubscriptions,
  saveSubscriptions,
  recategorizeTransaction,
  recategorizeAllTransactions,
  rescanRecurringMatches,
  linkRecurringCharge,
  unlinkRecurringCharge,
  markRecurringPaid,
  unmarkRecurringPaid,
  setTransactionExcluded,
  dismissOneTimeSuggestion,
  acceptFinanceActions,
  applyRecurringInsight,
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
  buildBudgetInsight,
  calculateEmergencyFund,
  detectOneTimeCandidates,
  recurringAdditionsForMonth,
  recurringAdditionsFromItems,
  amountWithinRecurringTolerance,
  recurringItemsForMonth,
  recurringMatchesTransaction,
  recurringNamesShareToken,
  simulateDebtPayoff,
  transactionsBeforeMonth,
  transactionsForMonth,
  type BudgetBucket,
  type OneTimeCandidate,
  type BudgetRecurringItem,
  type RecurringInsight,
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

function CollapsibleCard({
  id,
  title,
  icon: Icon,
  summary,
  badge,
  defaultOpen = false,
  forceOpen = false,
  children,
  className,
}: {
  id: string;
  title: string;
  icon?: LucideIcon;
  summary: ReactNode;
  badge?: number;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const storageKey = `finance:card:${id}`;
  const [storedOpen, setStoredOpen] = useState(() => {
    if (typeof window === "undefined") return defaultOpen;
    const saved = window.localStorage.getItem(storageKey);
    return saved === null ? defaultOpen : saved === "true";
  });
  const open = forceOpen || storedOpen;

  function toggle() {
    const next = !open;
    setStoredOpen(next);
    if (typeof window !== "undefined") window.localStorage.setItem(storageKey, String(next));
  }

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <button
          type="button"
          onClick={toggle}
          className="flex w-full items-center justify-between gap-3 text-left"
          aria-expanded={open}
        >
          <span className="flex min-w-0 items-center gap-2">
            {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
            <span className="truncate text-base font-semibold leading-none tracking-tight">
              {title}
            </span>
            {typeof badge === "number" && badge > 0 && (
              <Badge variant="secondary" className="shrink-0 text-[10px] tabular-nums">
                {badge}
              </Badge>
            )}
          </span>
          <span className="flex min-w-0 shrink-0 items-center gap-2 text-xs font-normal text-muted-foreground">
            <span className="hidden max-w-[12rem] truncate sm:inline">{summary}</span>
            <ChevronDown className={`size-4 transition-transform ${open ? "" : "-rotate-90"}`} />
          </span>
        </button>
        <div className="mt-2 text-xs text-muted-foreground sm:hidden">{summary}</div>
      </CardHeader>
      {open && <CardContent>{children}</CardContent>}
    </Card>
  );
}

function InfoHint({ children, label = "More info" }: { children: ReactNode; label?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 text-muted-foreground hover:text-foreground"
          aria-label={label}
        >
          <Info className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-w-xs text-sm text-muted-foreground">
        {children}
      </PopoverContent>
    </Popover>
  );
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
  const { data: advice = null, isPending: adviceLoading } = useQuery(financeAdviceQuery(today));
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
                adviceLoading={adviceLoading}
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
  flash: (msg: string, ms?: number) => void;
};

/* ---------------- Overview ---------------- */

function OverviewTab({
  hub,
  today,
  adviceItems,
  adviceLoading,
  onChange,
  flash,
}: TabProps & { today: string; adviceItems: FinanceAdviceItem[]; adviceLoading: boolean }) {
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

      {plannedRecurring > 0 && (
        <p className="-mt-2 text-xs text-muted-foreground">
          Known outflow includes {fmtMoney(plannedRecurring)} of active recurring commitments not
          seen in imported statements yet.
        </p>
      )}

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

// Coach's "next moves" — always visible when suggestions exist (never
// collapsed), compact and scannable. This is the single home for finance coach
// suggestions; the Budget tab intentionally has none. Shows the top 3.
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
        <span className="text-[11px] font-normal uppercase tracking-wide text-muted-foreground">
          Coach
        </span>
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
        className="overflow-hidden border-primary/25 bg-linear-to-br from-primary/8 via-card to-card shadow-sm"
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
    <Card className="overflow-hidden border-primary/25 bg-linear-to-br from-primary/8 via-card to-card shadow-sm">
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
                  <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {meta.label}
                  </div>
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
    <CollapsibleCard
      id="simplefin-connections"
      title="Bank connections"
      icon={Link2}
      summary={
        connected
          ? status?.lastSync
            ? `Last sync ${fmtDate(status.lastSync.at)}`
            : "Connected"
          : loading
            ? "Checking sync status"
            : "Not connected"
      }
      forceOpen={!!status?.missingSealKey || status?.lastSync?.ok === false}
    >
      <div className="space-y-3">
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
      </div>
    </CollapsibleCard>
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

function BudgetTab({ hub, month, onChange, flash }: TabProps & { month: string }) {
  const [takeHome, setTakeHome] = useState(moneyInputValue(hub.budget?.monthlyTakeHome));
  const [busy, setBusy] = useState(false);
  const [showAllInsightLines, setShowAllInsightLines] = useState(false);
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
  // Which hero tile's transaction breakdown is open (null = none).
  const [breakdown, setBreakdown] = useState<null | "spent" | "onetime" | "recurring">(null);

  const targets = hub.budget?.targets ?? DEFAULT_BUDGET_TARGETS;
  const th = Number(takeHome) || hub.budget?.monthlyTakeHome || 0;

  const monthTxns = transactionsForMonth(hub.transactions, selectedMonth);
  // Per-bucket totals + the transactions behind each bar. One-time charges the
  // user has marked (excludeFromBudget) are kept in the lists and tracked as real
  // money, but left out of plan totals so a single big bill doesn't blow the
  // monthly 50/30/20 comparison.
  const buckets: Record<BudgetBucket, number> = { needs: 0, wants: 0, savings: 0 };
  const bucketTxns: Record<BudgetBucket, Transaction[]> = {
    needs: [],
    wants: [],
    savings: [],
  };
  for (const t of monthTxns) {
    const b = moveOverrides[t.id] ?? spendBucketOf(t.categoryGroup);
    if (!b) continue;
    bucketTxns[b].push(t);
    if (!t.excludeFromBudget) buckets[b] += Math.abs(t.amount);
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
        subtotal: txns.reduce((s, t) => s + Math.abs(t.amount), 0),
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
              {th > 0 ? (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="gap-1.5">
                      <Pencil className="size-3.5" /> Edit take-home
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-72">
                    <TakeHomeEditor
                      value={takeHome}
                      onChange={setTakeHome}
                      onSave={saveTakeHome}
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
                    onClick={saveTakeHome}
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
              commitments from the Recurring tab that haven’t shown up in statements yet. “Left so
              far” is take-home minus what’s already posted this month; “Left after bills” also
              subtracts upcoming recurring commitments that haven’t posted yet. Targets are 50/30/20
              of the take-home baseline in this header.
            </InfoHint>
          </div>
          {th > 0 ? (
            <>
              {/* Hero: the two numbers that matter, with three secondary tiles. */}
              <div className="rounded-lg bg-muted/20 p-3 ring-1 ring-foreground/10">
                <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Left so far
                    </div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums sm:text-3xl">
                      {fmtMoney(budgetInsight.remainingCash)}
                    </div>
                  </div>
                  <div className="border-l border-border/60 pl-6">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Left after bills
                    </div>
                    <div className="mt-1 text-xl font-semibold tabular-nums text-muted-foreground sm:text-2xl">
                      {fmtMoney(budgetInsight.remainingAfterCommitted)}
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
  spentGroups: { key: BudgetBucket; label: string; subtotal: number; txns: Transaction[] }[];
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

function TakeHomeEditor({
  value,
  onChange,
  onSave,
  busy,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="th-popover" className="text-xs">
        After-tax pay per month
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id="th-popover"
          type="number"
          step="0.01"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Take-home"
          className="tabular-nums"
          disabled={busy}
        />
        <Button
          type="button"
          size="sm"
          onClick={onSave}
          disabled={busy || !value}
          className="gap-1"
        >
          <Check className="size-3.5" /> Save
        </Button>
      </div>
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
  const [filter, setFilter] = useState<BudgetBucket | "all">("all");
  const total = bucketTxns.needs.length + bucketTxns.wants.length + bucketTxns.savings.length;
  const rows = (
    filter === "all"
      ? SORTER_BUCKETS.flatMap(({ key }) => bucketTxns[key].map((t) => ({ t, bucket: key })))
      : bucketTxns[filter].map((t) => ({ t, bucket: filter }))
  ).sort((a, b) => Math.abs(b.t.amount) - Math.abs(a.t.amount));
  const filters: { key: BudgetBucket | "all"; label: string; count: number; sum: number }[] = [
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
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {label}
                  </div>
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

function recurringInsightKey(insight: RecurringInsight): string {
  return `${insight.subscriptionId}:${insight.kind}:${insight.suggestedAmount ?? ""}:${insight.lastChargeAt ?? ""}`;
}

function RecurringUpdatesCard({
  insights,
  subscriptions,
  onAccept,
  onDismiss,
}: {
  insights: RecurringInsight[];
  subscriptions: Subscription[];
  onAccept: (insight: RecurringInsight) => Promise<void>;
  onDismiss: (insight: RecurringInsight) => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function accept(insight: RecurringInsight) {
    const key = recurringInsightKey(insight);
    setBusyKey(key);
    try {
      await onAccept(insight);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <Card className="border-amber-200/70 bg-amber-50/40 dark:border-amber-900/60 dark:bg-amber-950/20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" /> Recurring updates
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {insights.map((insight) => {
            const sub = subscriptions.find((s) => s.id === insight.subscriptionId);
            if (!sub) return null;
            const key = recurringInsightKey(insight);
            const busy = busyKey === key;
            return (
              <li
                key={key}
                className="rounded-lg bg-background/80 p-3 text-sm ring-1 ring-foreground/10"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{cleanMerchantName(sub.name)}</span>
                      <Badge variant={insight.kind === "amount-change" ? "secondary" : "outline"}>
                        {insight.kind === "amount-change" ? "Amount changed" : "Likely canceled"}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{insight.reason}</p>
                    {insight.kind === "amount-change" && insight.suggestedAmount && (
                      <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                        {fmtMoney(sub.amount)} → {fmtMoney(insight.suggestedAmount)} per{" "}
                        {sub.cadence}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      className="h-7 gap-1 text-xs"
                      onClick={() => accept(insight)}
                      disabled={busy}
                    >
                      {busy ? (
                        <RefreshCw className="size-3.5 animate-spin" />
                      ) : (
                        <Check className="size-3.5" />
                      )}
                      {insight.kind === "amount-change"
                        ? `Update to ${fmtMoney(insight.suggestedAmount ?? sub.amount)}`
                        : "Mark canceled"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-muted-foreground"
                      onClick={() => onDismiss(insight)}
                      disabled={busy}
                    >
                      {insight.kind === "amount-change" ? "Dismiss" : "Keep active"}
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

type RecurringChargeStatus = {
  label: string;
  tone: "paid" | "unpaid";
  // For unpaid rows: when this commitment was last charged (usually last month),
  // so a not-yet-posted bill reads differently from one that has lapsed.
  lastPaidLabel?: string;
};

function RecurringRow({
  s,
  chargeStatus,
  amountChangeInsight,
  onChangeKind,
  onChangeGroup,
  onToggleCancel,
  onSaveEdit,
  onDelete,
}: {
  s: Subscription;
  chargeStatus?: RecurringChargeStatus;
  amountChangeInsight?: RecurringInsight;
  onChangeKind: (s: Subscription, k: RecurringKind) => void;
  onChangeGroup: (s: Subscription, g: SpendGroup) => void;
  onToggleCancel: (s: Subscription) => void;
  onSaveEdit: (s: Subscription, patch: Partial<Subscription>) => void;
  onDelete: (s: Subscription) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editName, setEditName] = useState(s.name);
  const [editAmount, setEditAmount] = useState(String(s.amount));
  const [editCadence, setEditCadence] = useState<Subscription["cadence"]>(s.cadence);
  const [editBalance, setEditBalance] = useState(s.balance != null ? String(s.balance) : "");
  const [editApr, setEditApr] = useState(s.apr != null ? String(s.apr) : "");
  const kind = recurringKindOf(s);
  const canceled = s.status === "canceled";
  const monthly = subscriptionMonthlyCost(s);
  const chargeStatusClass =
    chargeStatus?.tone === "paid"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-amber-700 dark:text-amber-400";

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
        {s.matchHints?.length ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">Linked charges</span>
            {s.matchHints.map((hint) => (
              <button
                key={hint}
                type="button"
                onClick={() =>
                  onSaveEdit(s, { matchHints: (s.matchHints ?? []).filter((h) => h !== hint) })
                }
                className="inline-flex h-7 items-center gap-1 rounded-full bg-muted px-2 text-xs text-muted-foreground ring-1 ring-foreground/10 transition-colors hover:text-destructive"
                aria-label={`Remove linked charge ${hint}`}
              >
                <span className="max-w-32 truncate">{hint}</span>
                <X className="size-3 shrink-0" />
              </button>
            ))}
          </div>
        ) : null}
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
              <span className={chargeStatusClass}> · {chargeStatus.label}</span>
            )}
            {chargeStatus?.lastPaidLabel && !canceled && (
              <span className="text-muted-foreground"> · {chargeStatus.lastPaidLabel}</span>
            )}
          </div>
          {loanMeta.length > 0 && (
            <div className="text-[11px] tabular-nums text-muted-foreground">
              {loanMeta.join(" · ")}
            </div>
          )}
          {amountChangeInsight?.suggestedAmount != null && !canceled && (
            <div className="text-[11px] tabular-nums text-amber-700 dark:text-amber-400">
              Statement shows {fmtMoney(amountChangeInsight.suggestedAmount)} — tracked amount may
              be stale
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
          {confirmingDelete ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs text-destructive"
                onClick={() => onDelete(s)}
                aria-label={`Confirm delete ${cleanMerchantName(s.name)}`}
              >
                <Trash2 className="size-3.5" /> Delete?
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs text-muted-foreground"
                onClick={() => setConfirmingDelete(false)}
              >
                Keep
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-muted-foreground transition-colors hover:text-destructive"
              onClick={() => setConfirmingDelete(true)}
              aria-label={`Delete ${cleanMerchantName(s.name)}`}
            >
              <Trash2 className="size-3.5" /> Delete
            </Button>
          )}
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
function PaymentCheckRow({
  item,
  month,
  candidates,
  onLinkCharge,
  onUnlinkCharge,
  onMarkPaid,
  onUnmarkPaid,
}: {
  item: BudgetRecurringItem;
  month?: string;
  candidates?: Transaction[];
  onLinkCharge?: (subId: string, txnId: string) => Promise<void>;
  onUnlinkCharge?: (txnId: string) => Promise<void>;
  onMarkPaid?: (subId: string, month: string) => Promise<void>;
  onUnmarkPaid?: (subId: string, month: string) => Promise<void>;
}) {
  const isAnnual = item.cadence === "annual";
  const seenCount =
    item.expectedThisMonth > 0
      ? Math.min(item.matchedCount, item.expectedThisMonth)
      : item.matchedCount;
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [marking, setMarking] = useState(false);

  async function link(t: Transaction) {
    if (!onLinkCharge || linking) return;
    setLinking(true);
    try {
      await onLinkCharge(item.id, t.id);
    } finally {
      setLinking(false);
    }
  }

  async function unlink() {
    if (!onUnlinkCharge || !item.matchedTxn || unlinking) return;
    setUnlinking(true);
    try {
      await onUnlinkCharge(item.matchedTxn.id);
    } finally {
      setUnlinking(false);
    }
  }

  async function markPaid() {
    if (!onMarkPaid || !month || marking) return;
    setMarking(true);
    try {
      await onMarkPaid(item.id, month);
    } finally {
      setMarking(false);
    }
  }

  async function unmarkPaid() {
    if (!onUnmarkPaid || !month || marking) return;
    setMarking(true);
    try {
      await onUnmarkPaid(item.id, month);
    } finally {
      setMarking(false);
    }
  }

  const showCandidates =
    !item.seenThisMonth && !!onLinkCharge && !!candidates && candidates.length > 0;
  const aiLinked = item.matchedTxn?.matchSource === "ai";
  const manualPaid = item.matchedTxn?.manual === true;
  // Offer a cash/Venmo "mark paid" whenever the month still expects a payment:
  // any unseen item, or a weekly item that hasn't hit its expected count yet.
  const canMarkPaid =
    !!onMarkPaid &&
    !!month &&
    (item.expectedThisMonth > 0 ? item.matchedCount < item.expectedThisMonth : !item.seenThisMonth);
  return (
    <li className="py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
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
                {aiLinked && (
                  <>
                    <Badge
                      variant="secondary"
                      className="h-5 gap-1 rounded-md px-1.5 text-[10px] text-primary"
                    >
                      <Sparkles className="size-3" />
                      AI-linked
                    </Badge>
                    {onUnlinkCharge && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-5 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                        onClick={unlink}
                        disabled={unlinking}
                      >
                        <X className="size-3" />
                        Unlink
                      </Button>
                    )}
                  </>
                )}
                {manualPaid && (
                  <>
                    <Badge
                      variant="secondary"
                      className="h-5 gap-1 rounded-md px-1.5 text-[10px] text-primary"
                    >
                      <Banknote className="size-3" />
                      Cash / Venmo
                    </Badge>
                    {onUnmarkPaid && month && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-5 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                        onClick={unmarkPaid}
                        disabled={marking}
                      >
                        <X className="size-3" />
                        Undo
                      </Button>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                {isAnnual
                  ? "Annual - excluded from monthly check"
                  : item.expectedThisMonth > 1
                    ? `0 of ${item.expectedThisMonth} weekly charges seen this month`
                    : "Not seen in statements this month"}
                {item.lastPaidTxn && (
                  <span> · Last paid {fmtDate(item.lastPaidTxn.timestamp)}</span>
                )}
              </div>
            )}
          </div>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          ~{fmtMoney(item.monthlyAmount)}/mo
        </span>
      </div>
      {showCandidates && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-6">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Link charge
          </span>
          {candidates!.map((t) => (
            <Button
              key={t.id}
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              disabled={linking}
              onClick={() => link(t)}
              aria-label={`Link ${cleanMerchantName(item.name)} to ${cleanMerchantName(
                t.category || t.notes || "",
              )}`}
            >
              <Link2 className="size-3 shrink-0" />
              <span className="max-w-32 truncate">
                {cleanMerchantName(t.category || t.notes || "")}
              </span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{fmtMoney(Math.abs(t.amount))}</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{fmtDate(t.timestamp)}</span>
            </Button>
          ))}
        </div>
      )}
      {canMarkPaid && (
        <div className="mt-1.5 pl-6">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            disabled={marking}
            onClick={markPaid}
            aria-label={`Mark ${cleanMerchantName(item.name)} paid via cash or Venmo`}
          >
            <Banknote className="size-3 shrink-0" />
            Mark paid (cash / Venmo)
          </Button>
        </div>
      )}
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
  onLinkCharge,
  onUnlinkCharge,
  onMarkPaid,
  onUnmarkPaid,
  onRescanAiMatches,
}: {
  subscriptions: Subscription[];
  transactions: Transaction[];
  onLinkCharge: (subId: string, txnId: string) => Promise<void>;
  onUnlinkCharge: (txnId: string) => Promise<void>;
  onMarkPaid: (subId: string, month: string) => Promise<void>;
  onUnmarkPaid: (subId: string, month: string) => Promise<void>;
  onRescanAiMatches: () => Promise<void>;
}) {
  const currentMonth = todayISO().slice(0, 7);
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const isCurrentMonth = selectedMonth === currentMonth;
  const monthLabel = formatMonthLabel(selectedMonth);
  const monthTxns = transactionsForMonth(transactions, selectedMonth);
  const hasMonthTxns = monthTxns.length > 0;
  const monthItems = recurringItemsForMonth(
    subscriptions,
    monthTxns,
    transactionsBeforeMonth(transactions, selectedMonth),
  );
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
  const [rescanning, setRescanning] = useState(false);
  const open = userOpen ?? !allClear;
  const pendingItems = ordered.filter(
    (item) => item.expectedThisMonth > 0 && item.matchedCount < item.expectedThisMonth,
  );
  const matchedItems = ordered.filter(
    (item) => !(item.expectedThisMonth > 0 && item.matchedCount < item.expectedThisMonth),
  );

  // Charges a pending item could be linked to: persisted AI suggestions first,
  // then the deterministic floor - charges in the amount band whose cleaned bank
  // descriptor shares a real word with the item name. Amount alone is never
  // enough to suggest: a wrong-but-plausible guess is worse than silence.
  const activeSubs = subscriptions.filter((s) => s.status === "active");
  const merchantLabel = (t: Transaction) =>
    cleanMerchantName(t.category || t.notes || "").toLowerCase();
  function candidatesFor(item: BudgetRecurringItem): Transaction[] {
    const sub = subscriptions.find((s) => s.id === item.id);
    if (!sub) return [];
    const unclaimed = (t: Transaction) =>
      !activeSubs.some((a) => recurringMatchesTransaction(a, t));
    const byCloseness = (a: Transaction, b: Transaction) => {
      const da = Math.abs(Math.abs(a.amount) - sub.amount);
      const db = Math.abs(Math.abs(b.amount) - sub.amount);
      if (da !== db) return da - db;
      return b.timestamp - a.timestamp;
    };

    const suggested = monthTxns.filter(
      (t) => t.amount < 0 && t.recurringSuggestedId === item.id && unclaimed(t),
    );

    const related = monthTxns
      .filter(
        (t) =>
          t.amount < 0 &&
          t.categoryGroup !== "income" &&
          t.categoryGroup !== "transfer" &&
          amountWithinRecurringTolerance(sub, t.amount) &&
          unclaimed(t) &&
          recurringNamesShareToken(sub.name, merchantLabel(t)),
      )
      .sort(byCloseness);

    const seen = new Set(suggested.map((t) => t.id));
    return [...suggested, ...related.filter((t) => !seen.has(t.id))].slice(0, 3);
  }

  async function rescan() {
    if (rescanning) return;
    setRescanning(true);
    try {
      await onRescanAiMatches();
    } finally {
      setRescanning(false);
    }
  }

  return (
    <CollapsibleCard
      id="monthly-payment-check"
      title="Monthly payment check"
      icon={ListChecks}
      summary={
        <span
          className={
            allClear
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-amber-600 dark:text-amber-400"
          }
        >
          {seen} of {total} paid
        </span>
      }
      defaultOpen={!allClear}
      forceOpen={!allClear && total > 0}
    >
      <div className="mb-3 flex justify-end">
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
      </div>
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
                It’s early in {monthLabel} — most payments haven’t posted yet. Step back a month to
                verify a completed month.
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
                      <PaymentCheckRow
                        key={item.id}
                        item={item}
                        month={selectedMonth}
                        candidates={candidatesFor(item)}
                        onLinkCharge={onLinkCharge}
                        onUnlinkCharge={onUnlinkCharge}
                        onMarkPaid={onMarkPaid}
                        onUnmarkPaid={onUnmarkPaid}
                      />
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
                      <PaymentCheckRow
                        key={item.id}
                        item={item}
                        month={selectedMonth}
                        onUnlinkCharge={onUnlinkCharge}
                        onMarkPaid={onMarkPaid}
                        onUnmarkPaid={onUnmarkPaid}
                      />
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
          <div className="mt-3 flex flex-col gap-2 text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <p className="text-pretty">
              Matching compares each item’s name and approximate amount to statement lines. If a
              payment was made but shows unmatched, edit the item so its name matches how it appears
              on your statement (e.g. “Delmarva Power”, not “Electric”) or update its amount.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={rescan}
              disabled={rescanning}
              className="h-8 shrink-0 gap-1.5 text-xs"
            >
              {rescanning ? (
                <RefreshCw className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              Re-scan for AI matches
            </Button>
          </div>
        )
      )}
    </CollapsibleCard>
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
    <CollapsibleCard
      id="debt-payoff"
      title="Debt payoff comparison"
      icon={Landmark}
      summary={
        interestDelta > 0 ? `Avalanche saves ${fmtMoney(interestDelta)}` : `${debts.length} debts`
      }
      className="border-amber-500/20 bg-linear-to-br from-amber-500/6 to-card"
    >
      <div className="mb-3 flex justify-end">
        <div className="flex items-center gap-2">
          <Label htmlFor="extra-debt-payment" className="text-xs font-normal text-muted-foreground">
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
      </div>
      <div className="space-y-4">
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
      </div>
    </CollapsibleCard>
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
  const [dismissedInsights, setDismissedInsights] = useState<Set<string>>(new Set());

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
  const visibleInsights = hub.recurringInsights.filter(
    (insight) => !dismissedInsights.has(recurringInsightKey(insight)),
  );
  const amountChangeInsightById = new Map(
    visibleInsights
      .filter((insight) => insight.kind === "amount-change")
      .map((insight) => [insight.subscriptionId, insight]),
  );

  // Which items matched this month's transactions, so rows answer whether the
  // expected charge has been seen without making the user open the checklist.
  const currentMonth = todayISO().slice(0, 7);
  const currentMonthTxns = transactionsForMonth(hub.transactions, currentMonth);
  const monthItems = recurringItemsForMonth(
    hub.subscriptions,
    currentMonthTxns,
    transactionsBeforeMonth(hub.transactions, currentMonth),
  );
  const chargeStatusById = new Map(
    (["needs", "wants", "savings"] as const)
      .flatMap((bucket) => monthItems[bucket])
      .filter((item) => item.cadence !== "annual" && item.expectedThisMonth > 0)
      .map((item) => [
        item.id,
        item.seenThisMonth
          ? {
              label:
                item.expectedThisMonth > 1
                  ? `${Math.min(item.matchedCount, item.expectedThisMonth)} of ${
                      item.expectedThisMonth
                    } charges seen this month`
                  : "charged this month",
              tone: "paid" as const,
            }
          : {
              label:
                item.expectedThisMonth > 1
                  ? `0 of ${item.expectedThisMonth} charges seen this month`
                  : "not seen this month",
              tone: "unpaid" as const,
              lastPaidLabel: item.lastPaidTxn
                ? `last paid ${fmtDate(item.lastPaidTxn.timestamp)}`
                : undefined,
            },
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

  // Hard delete: drop the row from the collection entirely. Cancel keeps a
  // paused record (and stops it counting); delete is for entries that should
  // never have existed — e.g. a manual bill now fully covered by bank sync.
  async function deleteSubscription(s: Subscription) {
    await persist(hub.subscriptions.filter((x) => x.id !== s.id));
    flash(`Deleted ${cleanMerchantName(s.name)}.`);
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

  async function linkCharge(subId: string, txnId: string) {
    const sub = hub.subscriptions.find((x) => x.id === subId);
    if (!sub) return;
    await linkRecurringCharge({ data: { subId, txnId } });
    await onChange();
    flash(`Linked ${cleanMerchantName(sub.name)} to that charge.`);
  }

  async function unlinkCharge(txnId: string) {
    await unlinkRecurringCharge({ data: { txnId } });
    await onChange();
    flash("Unlinked that charge.");
  }

  async function markPaid(subId: string, month: string) {
    const sub = hub.subscriptions.find((x) => x.id === subId);
    if (!sub) return;
    await markRecurringPaid({ data: { subId, month } });
    await onChange();
    flash(`Marked ${cleanMerchantName(sub.name)} paid.`);
  }

  async function unmarkPaid(subId: string, month: string) {
    const sub = hub.subscriptions.find((x) => x.id === subId);
    await unmarkRecurringPaid({ data: { subId, month } });
    await onChange();
    flash(`Undid manual payment${sub ? ` for ${cleanMerchantName(sub.name)}` : ""}.`);
  }

  async function rescanAiMatches() {
    flash("Re-scanning unmatched charges…");
    try {
      const res = await rescanRecurringMatches({ data: {} });
      await onChange();
      const summary =
        `Linked ${res.linked}, suggested ${res.suggested} across ${res.merchantsScanned} merchant${
          res.merchantsScanned === 1 ? "" : "s"
        }` +
        (res.merchantsRemaining > 0
          ? `. ${res.merchantsRemaining} merchant${
              res.merchantsRemaining === 1 ? "" : "s"
            } remain — run again.`
          : ".");
      flash(summary, 6000);
    } catch (err) {
      console.error(err);
      flash("Couldn’t re-scan unmatched charges.");
    }
  }

  function dismissInsight(insight: RecurringInsight) {
    setDismissedInsights((current) => new Set(current).add(recurringInsightKey(insight)));
  }

  async function acceptInsight(insight: RecurringInsight) {
    const sub = hub.subscriptions.find((s) => s.id === insight.subscriptionId);
    if (!sub) return;
    if (insight.kind === "amount-change" && !insight.suggestedAmount) return;
    await applyRecurringInsight({
      data: {
        subscriptionId: insight.subscriptionId,
        action: insight.kind === "amount-change" ? "update-amount" : "cancel",
        amount: insight.suggestedAmount,
        lastSeen: insight.lastChargeAt,
      },
    });
    dismissInsight(insight);
    await onChange();
    flash(
      insight.kind === "amount-change"
        ? `Updated ${cleanMerchantName(sub.name)} to ${fmtMoney(insight.suggestedAmount ?? sub.amount)}.`
        : `Marked ${cleanMerchantName(sub.name)} canceled.`,
    );
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
      <div className="-mt-1 flex items-center gap-1 text-xs text-muted-foreground">
        <span>Fixed obligations, subscriptions, and recurring savings.</span>
        <InfoHint>
          Loans & bills are fixed Needs that flow into your Budget; subscriptions are cuttable
          Wants; recurring savings is money kept, not spend.
        </InfoHint>
      </div>

      {visibleInsights.length > 0 && (
        <RecurringUpdatesCard
          insights={visibleInsights}
          subscriptions={hub.subscriptions}
          onAccept={acceptInsight}
          onDismiss={dismissInsight}
        />
      )}

      <MonthlyPaymentCheckCard
        subscriptions={hub.subscriptions}
        transactions={hub.transactions}
        onLinkCharge={linkCharge}
        onUnlinkCharge={unlinkCharge}
        onMarkPaid={markPaid}
        onUnmarkPaid={unmarkPaid}
        onRescanAiMatches={rescanAiMatches}
      />

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
                            amountChangeInsight={amountChangeInsightById.get(s.id)}
                            onChangeKind={changeKind}
                            onChangeGroup={changeGroup}
                            onToggleCancel={toggleCancel}
                            onSaveEdit={saveEdit}
                            onDelete={deleteSubscription}
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

      <CollapsibleCard
        id="recurring-add"
        title="Add manually"
        icon={Plus}
        summary="Loan / bill / subscription"
      >
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
            <Select value={cadence} onValueChange={(v) => setCadence(v as Subscription["cadence"])}>
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
          Loans &amp; Bills are essential Needs and flow into your Budget automatically each month.
          Subscriptions are discretionary (Want) or a recurring Save. Switch a row's type anytime to
          move it between sections.
        </p>
      </CollapsibleCard>
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
  const [showAddPosition, setShowAddPosition] = useState(false);
  const [showAllPositions, setShowAllPositions] = useState(false);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [liveSymbols, setLiveSymbols] = useState<Set<string>>(new Set());

  const positions = hub.snapshot.positions || [];
  const total = positions.reduce((s, p) => s + (p.value || 0), 0);
  const sortedPositions = [...positions].sort((a, b) => (b.value || 0) - (a.value || 0));
  const visiblePositions = showAllPositions ? sortedPositions : sortedPositions.slice(0, 5);
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
      <div className="rounded-xl bg-card px-4 py-4 ring-1 ring-foreground/10">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Holdings total value
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums sm:text-3xl">
          {fmtMoney(total)}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <MiniStat label="Positions" value={String(positions.length)} />
          <MiniStat
            label="Top holding"
            value={topHolding ? `${topHolding.symbol} · ${allocationPct(topHolding)}%` : "—"}
          />
        </div>
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
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="shrink-0 gap-1 whitespace-nowrap transition-[scale,background-color,color,box-shadow] active:scale-[0.96]"
              onClick={() => setShowAddPosition((open) => !open)}
            >
              <Plus className="size-4" /> {showAddPosition ? "Hide form" : "Add position"}
            </Button>
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
          </div>
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
                  {visiblePositions.map((p) => {
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
              {sortedPositions.length > 5 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  onClick={() => setShowAllPositions((show) => !show)}
                >
                  {showAllPositions ? "Show top 5" : `Show all ${sortedPositions.length}`}
                </Button>
              )}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              No holdings yet. Brokerage positions (Robinhood) arrive automatically with each
              SimpleFIN sync; add anything else manually (e.g. your ADP 401k balance as symbol
              “401K”).
            </div>
          )}
          {showAddPosition && (
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
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Educational guidance only. This app never moves money or executes trades.
      </p>
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
// file omit `onClick` and are unaffected.
function MiniStat({
  label,
  value,
  onClick,
}: {
  label: string;
  value: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </>
  );
  if (!onClick) {
    return <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      className="relative cursor-pointer rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-left transition-colors hover:bg-muted/40 hover:ring-1 hover:ring-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronRight
        className="absolute top-1.5 right-1.5 size-3 text-muted-foreground/50"
        aria-hidden
      />
      {body}
    </button>
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
  // Only list recurring items that still add planned dollars to the bucket.
  // Fully-matched items are already represented by their transaction row.
  const plannedItems = recurringItems.filter((i) => i.remainingMonthlyAmount > 0);
  const expandable = (txns.length > 0 && !!onToggleExclude) || plannedItems.length > 0;
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
          {plannedItems.length > 0 && (
            <li className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs font-medium">
              <div className="min-w-0 flex-1">
                <div className="truncate">Monthly recurring plan</div>
                <div className="text-muted-foreground">
                  {fmtMoney(recurringEstimate)} not seen in statements yet
                </div>
              </div>
            </li>
          )}
          {plannedItems.map((item) => (
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
                  {item.lastPaidTxn ? ` · last paid ${fmtDate(item.lastPaidTxn.timestamp)}` : ""}
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
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate">
                      {t.category ? cleanMerchantName(t.category) : "—"}
                    </span>
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
                <span className="shrink-0 tabular-nums">{fmtMoney(Math.abs(t.amount))}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onToggleExclude?.(t.id, !excluded)}
                  className="h-auto shrink-0 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  title={excluded ? "Count this in the plan again" : "Mark as a one-time charge"}
                >
                  {excluded ? "Include in plan" : "Mark one-time"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
