import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Reveal, revealDelay } from "@/components/motion";
import { financeHubQuery, queryKeys } from "@/lib/queries";
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
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveDailyFinance } from "@/server/domain";
import {
  saveBudget,
  importTransactions,
  detectSubscriptions,
  saveSubscriptions,
  recategorizeTransaction,
  recategorizeAllTransactions,
  setTransactionExcluded,
  generateFinanceAdvice,
  acceptFinanceActions,
  refreshQuotes,
  type FinanceHubPayload,
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
  type FinanceAdviceItem,
} from "@/lib/domain";

type TabKey = "overview" | "budget" | "subscriptions" | "investments" | "grow";

const TABS: { key: TabKey; label: string; Icon: typeof Wallet }[] = [
  { key: "overview", label: "Overview", Icon: Wallet },
  { key: "budget", label: "Budget", Icon: PiggyBank },
  { key: "subscriptions", label: "Recurring", Icon: Repeat },
  { key: "investments", label: "Investments", Icon: TrendingUp },
  { key: "grow", label: "Grow", Icon: Lightbulb },
];

const INSTITUTIONS = ["Bank of America", "M&T Bank", "Capital One", "Robinhood", "Other"];

export const Route = createFileRoute("/finance")({
  validateSearch: (search: Record<string, unknown>): { tab?: TabKey } => {
    const raw = typeof search.tab === "string" ? search.tab : undefined;
    const valid = TABS.some((t) => t.key === raw) ? (raw as TabKey) : undefined;
    return { tab: valid };
  },
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(financeHubQuery(todayISO())),
  component: FinancePage,
});

function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

function moneyInputValue(n: number | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "";
}

function monthKeyFromTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
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

type BudgetBucket = "needs" | "wants" | "savings";
type BudgetRecurringItem = {
  id: string;
  name: string;
  kind: RecurringKind;
  cadence: Subscription["cadence"];
  monthlyAmount: number;
  account?: string;
  seenThisMonth: boolean;
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

function normalizedFinanceLabel(raw?: string): string {
  return cleanMerchantName(raw || "").toLowerCase();
}

function recurringMatchesTransaction(sub: Subscription, t: Transaction): boolean {
  if (t.amount >= 0) return false;
  const amount = Math.abs(t.amount);
  const amountMatches = Math.abs(amount - sub.amount) <= Math.max(1, sub.amount * 0.05);
  if (!amountMatches) return false;

  const subName = normalizedFinanceLabel(sub.name);
  const txnName = normalizedFinanceLabel(t.category || t.notes || "");
  const nameMatches =
    !!subName && !!txnName && (txnName.includes(subName) || subName.includes(txnName));
  const accountMatches =
    !!sub.account &&
    !!t.account &&
    sub.account.trim().toLowerCase() === t.account.trim().toLowerCase();
  return nameMatches || accountMatches;
}

function recurringItemsForMonth(
  subscriptions: Subscription[],
  monthTxns: Transaction[],
): Record<BudgetBucket, BudgetRecurringItem[]> {
  const items: Record<BudgetBucket, BudgetRecurringItem[]> = { needs: [], wants: [], savings: [] };
  for (const sub of subscriptions) {
    if (sub.status !== "active") continue;
    const bucket = recurringBudgetBucket(sub);
    items[bucket].push({
      id: sub.id,
      name: sub.name,
      kind: recurringKindOf(sub),
      cadence: sub.cadence,
      monthlyAmount: subscriptionMonthlyCost(sub),
      account: sub.account,
      seenThisMonth: monthTxns.some((t) => recurringMatchesTransaction(sub, t)),
    });
  }
  for (const bucket of ["needs", "wants", "savings"] as const) {
    items[bucket].sort((a, b) => b.monthlyAmount - a.monthlyAmount);
  }
  return items;
}

function recurringAdditionsForMonth(
  subscriptions: Subscription[],
  monthTxns: Transaction[],
): Record<BudgetBucket, number> {
  const items = recurringItemsForMonth(subscriptions, monthTxns);
  return recurringAdditionsFromItems(items);
}

function recurringAdditionsFromItems(
  items: Record<BudgetBucket, BudgetRecurringItem[]>,
): Record<BudgetBucket, number> {
  return {
    needs: items.needs.reduce(
      (sum, item) => sum + (item.seenThisMonth ? 0 : item.monthlyAmount),
      0,
    ),
    wants: items.wants.reduce(
      (sum, item) => sum + (item.seenThisMonth ? 0 : item.monthlyAmount),
      0,
    ),
    savings: items.savings.reduce(
      (sum, item) => sum + (item.seenThisMonth ? 0 : item.monthlyAmount),
      0,
    ),
  };
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
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string | null>(null);

  // Tabs call this after a mutation: invalidate → refetch the hub so every view
  // bound to it updates.
  const reload = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.financeHub(today) }),
    [queryClient, today],
  );

  function flash(msg: string, ms = 3500) {
    setStatus(msg);
    setTimeout(() => setStatus(null), ms);
  }

  const netWorth = hub?.snapshot.netWorth ?? 0;

  return (
    <div className="min-h-dvh bg-background px-4 pb-16 pt-8 sm:px-6">
      <div className="mx-auto w-full max-w-page">
        {/* Header */}
        <div className="mb-5">
          <div className="text-xs uppercase tracking-[2px] text-muted-foreground">Money</div>
          <div className="flex items-end justify-between gap-3">
            <div className="text-3xl font-semibold tracking-tighter">Finance Hub</div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Net worth
              </div>
              <div className="text-2xl font-semibold tabular-nums">{fmtMoney(netWorth)}</div>
            </div>
          </div>
        </div>

        {/* Tab bar */}
        <div className="mb-6 flex gap-1 overflow-x-auto rounded-lg border bg-muted/40 p-1">
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
                className={`flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
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
          <div className="mb-4 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
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
              <OverviewTab hub={hub} today={today} onChange={reload} flash={flash} />
            )}
            {tab === "budget" && (
              <BudgetTab hub={hub} month={month} onChange={reload} flash={flash} />
            )}
            {tab === "subscriptions" && <RecurringTab hub={hub} onChange={reload} flash={flash} />}
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

function OverviewTab({ hub, today, onChange, flash }: TabProps & { today: string }) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const accounts = hub.snapshot.accounts || [];
  const importedAccounts = summarizeImportedAccounts(hub.transactions);
  const savedBalanceNames = new Set(accounts.map((a) => a.account.toLowerCase()));
  const importedWithoutBalance = importedAccounts.filter(
    (a) => !savedBalanceNames.has(a.account.toLowerCase()),
  );
  const balanceSourceDate =
    hub.snapshotSourceDate && hub.snapshotSourceDate !== today ? hub.snapshotSourceDate : null;

  async function addAccount(e: React.FormEvent) {
    e.preventDefault();
    const amt = Number(amount);
    if (!name.trim() || !Number.isFinite(amt)) return;
    setBusy(true);
    try {
      const next = [...accounts];
      const idx = next.findIndex((a) => a.account.toLowerCase() === name.trim().toLowerCase());
      if (idx >= 0) next[idx] = { ...next[idx], amount: amt };
      else next.push({ account: name.trim(), amount: amt, currency: "USD" });
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
      setName("");
      setAmount("");
      await onChange();
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
      await onChange();
      flash("Account removed.");
    } catch (err) {
      console.error(err);
      flash("Couldn’t remove that account.");
    } finally {
      setBusy(false);
    }
  }

  const monthTxns = hub.transactions.filter(
    (t) => new Date(t.timestamp).toISOString().slice(0, 7) === today.slice(0, 7),
  );
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
              <ul className="mb-3 space-y-1 text-sm">
                {accounts.map((a) => (
                  <li
                    key={a.account}
                    className="flex items-center justify-between gap-2 border-b border-border/40 py-1.5 last:border-0"
                  >
                    <span className="min-w-0 flex-1 truncate">{a.account}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {fmtMoney(a.amount)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => removeAccount(a.account)}
                      disabled={busy}
                      aria-label={`Remove ${a.account}`}
                      title="Remove account"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
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
            Balances upsert by name. Remove a balance when you stop tracking an account.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function DataQualityCard({ hub, today }: { hub: FinanceHubPayload; today: string }) {
  const month = today.slice(0, 7);
  const monthTxns = hub.transactions.filter((t) => monthKeyFromTimestamp(t.timestamp) === month);
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

  const monthTxns = hub.transactions.filter(
    (t) => new Date(t.timestamp).toISOString().slice(0, 7) === selectedMonth,
  );
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
          <CardTitle className="text-base">Monthly take-home (50/30/20)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Label htmlFor="th" className="text-xs text-muted-foreground">
                After-tax pay per month (your ADP paycheck)
              </Label>
              <Input
                id="th"
                type="number"
                step="0.01"
                value={takeHome}
                onChange={(e) => setTakeHome(e.target.value)}
                placeholder="e.g. 6000"
                className="mt-1"
                disabled={busy}
              />
            </div>
            <Button onClick={saveTakeHome} disabled={busy || !takeHome} className="gap-1">
              <Check className="size-4" /> Save
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            <span>{isCurrentMonth ? "This month vs plan" : "Month vs plan"}</span>
            <MonthNav
              month={selectedMonth}
              onPrev={() => setSelectedMonth((m) => shiftMonth(m, -1))}
              onNext={() => setSelectedMonth((m) => shiftMonth(m, 1))}
              canGoNext={!isCurrentMonth}
            />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {th > 0 ? (
            <>
              {(["needs", "wants", "savings"] as const).map((b) => (
                <BudgetBar
                  key={b}
                  label={b}
                  actual={buckets[b]}
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
                <select
                  value={institution}
                  onChange={(e) => setInstitution(e.target.value)}
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                  disabled={busy}
                >
                  {INSTITUTIONS.map((i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </select>
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
        size="icon-xs"
        onClick={onPrev}
        aria-label="Previous month"
        title="Previous month"
      >
        <ChevronLeft className="size-4" />
      </Button>
      <span className="min-w-[92px] text-center tabular-nums">{formatMonthLabel(month)}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={onNext}
        disabled={!canGoNext}
        aria-label="Next month"
        title={canGoNext ? "Next month" : "Already at the current month"}
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
          <div className="tabular-nums text-muted-foreground">
            {new Date(t.timestamp).toLocaleDateString()}
          </div>
        </div>
        <span
          className={`shrink-0 tabular-nums ${excluded ? "text-muted-foreground line-through" : ""}`}
        >
          {fmtMoney(Math.abs(t.amount))}
        </span>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <GroupPicker value={bucket} onChange={(g) => onMove(t.id, g)} />
        <button
          type="button"
          onClick={() => onToggleExclude(t.id, !excluded)}
          className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
          title={excluded ? "Count this in the plan again" : "Mark as a one-time charge"}
        >
          {excluded ? "Include" : "One-time"}
        </button>
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
                <div className="text-xs text-muted-foreground tabular-nums">
                  {new Date(t.timestamp).toLocaleDateString()}
                </div>
              </div>
              <select
                value={t.categoryGroup ?? "wants"}
                onChange={(e) => recategorize(t.id, e.target.value as CategoryGroup)}
                className="h-7 rounded border bg-background px-1 text-xs"
              >
                {(Object.keys(GROUP_LABELS) as CategoryGroup[]).map((g) => (
                  <option key={g} value={g}>
                    {GROUP_LABELS[g]}
                  </option>
                ))}
              </select>
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
      className="inline-flex shrink-0 rounded-md border bg-muted/40 p-0.5"
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
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors disabled:opacity-50 ${
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
      className="inline-flex shrink-0 rounded-md border bg-muted/40 p-0.5"
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
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors disabled:opacity-50 ${
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
      className="inline-flex shrink-0 rounded-md border bg-muted/40 p-0.5"
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
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors disabled:opacity-50 ${
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
      className="inline-flex shrink-0 rounded-md border bg-muted/40 p-0.5"
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
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors disabled:opacity-50 ${
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
  onChangeKind,
  onChangeGroup,
  onToggleCancel,
}: {
  s: Subscription;
  onChangeKind: (s: Subscription, k: RecurringKind) => void;
  onChangeGroup: (s: Subscription, g: SpendGroup) => void;
  onToggleCancel: (s: Subscription) => void;
}) {
  const kind = recurringKindOf(s);
  const canceled = s.status === "canceled";
  const monthly = subscriptionMonthlyCost(s);
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
    <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className={`truncate ${canceled ? "line-through opacity-60" : ""}`}>
          {cleanMerchantName(s.name)}
        </div>
        <div className="text-xs text-muted-foreground">
          {fmtMoney(s.amount)}/{CADENCE_ABBR[s.cadence]}
          {s.source === "detected" ? " · detected" : ""}
        </div>
        {loanMeta.length > 0 && (
          <div className="text-[11px] tabular-nums text-muted-foreground">
            {loanMeta.join(" · ")}
          </div>
        )}
      </div>
      {!canceled && (
        <div className="flex items-center gap-1.5">
          <KindPicker value={kind} onChange={(k) => onChangeKind(s, k)} />
          {kind === "bill" && (
            <NeedWantPicker value={billGroup} onChange={(g) => onChangeGroup(s, g)} />
          )}
          {kind === "subscription" && (
            <SaveWantPicker value={subGroup} onChange={(g) => onChangeGroup(s, g)} />
          )}
        </div>
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

  async function addManual(e: React.FormEvent) {
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
        <Stat label="Obligations (mo)" value={fmtMoney(obligationsMonthly)} />
        <Stat label="Cuttable subs" value={fmtMoney(cuttableSubscriptionsMonthly)} tone="down" />
        <Stat label="Recurring save" value={fmtMoney(recurringSavingsMonthly)} tone="up" />
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">
        Loans &amp; bills ({fmtMoney(obligationsMonthly)}/mo) are fixed Needs that flow into your
        Budget. Cuttable subscriptions are Wants; recurring savings/investing contributions are
        Savings, not spend.
      </p>

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
                            onChangeKind={changeKind}
                            onChangeGroup={changeGroup}
                            onToggleCancel={toggleCancel}
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
                className="min-w-[140px] flex-1"
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
              <select
                value={cadence}
                onChange={(e) => setCadence(e.target.value as Subscription["cadence"])}
                className="h-9 rounded-md border bg-background px-2 text-sm"
                aria-label="Cadence"
              >
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="annual">Annual</option>
              </select>
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

  async function addPosition(e: React.FormEvent) {
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
      <Stat label="Holdings value" value={fmtMoney(total)} />

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
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
            className="gap-1"
            disabled={refreshing || !positions.length}
            onClick={refreshPrices}
          >
            <RefreshCw className={`size-4${refreshing ? " animate-spin" : ""}`} />
            {refreshing ? "Refreshing…" : "Refresh prices"}
          </Button>
        </CardHeader>
        <CardContent>
          {positions.length ? (
            <ul className="space-y-2">
              {positions.map((p, i) => {
                const pct = total > 0 ? Math.round(((p.value || 0) / total) * 100) : 0;
                // A single holding is always 100% — the bar and percent are noise.
                const showAllocation = positions.length > 1;
                const isLive = liveSymbols.has(p.symbol.toUpperCase());
                return (
                  <li key={i} className="text-sm">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 font-medium">
                        {p.symbol}
                        {isLive && (
                          <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                            <span className="size-1.5 rounded-full bg-emerald-500" />
                            Live
                          </span>
                        )}
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {p.quantity} × {fmtMoney(p.price)} = {fmtMoney(p.value || 0)}
                        {showAllocation ? ` (${pct}%)` : ""}
                      </span>
                    </div>
                    {showAllocation && (
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-muted">
                        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="text-sm text-muted-foreground">
              No holdings yet. Add Robinhood positions and your ADP 401k balance (enter it as a
              holding, e.g. symbol “401K”).
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

function GrowTab({
  hub,
  today,
  flash,
}: {
  hub: FinanceHubPayload;
  today: string;
  flash: (m: string) => void;
}) {
  const [items, setItems] = useState<FinanceAdviceItem[] | null>(null);
  const [generatedBy, setGeneratedBy] = useState<"ai" | "fallback" | null>(null);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);

  async function generate() {
    setBusy(true);
    setAccepted(false);
    try {
      const res = await generateFinanceAdvice({ data: { date: today } });
      setItems(res.items);
      setGeneratedBy(res.generatedBy);
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
      setAccepted(true);
      flash("Added to today’s tasks.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <RevenueGrowthCard hub={hub} today={today} />

      <div className="flex flex-col gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Personalized budget fixes, a subscription audit, and investing moves — grounded in your
          real numbers.
        </p>
        <Button onClick={generate} disabled={busy} className="shrink-0 gap-1.5">
          {busy ? <RefreshCw className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          {items ? "Regenerate advice" : "Generate advice"}
        </Button>
      </div>

      {items && (
        <>
          {items.map((it, i) => {
            const meta = ADVICE_META[it.category];
            return (
              <Reveal as="div" key={i} delay={revealDelay(i)}>
                <Card>
                  <CardContent className="flex gap-3 pt-5">
                    <meta.Icon className="mt-0.5 size-5 shrink-0 text-primary" />
                    <div>
                      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {meta.label}
                      </div>
                      <div className="text-sm">{it.text}</div>
                    </div>
                  </CardContent>
                </Card>
              </Reveal>
            );
          })}
          <div className="flex items-center gap-3">
            <Button
              onClick={acceptAll}
              disabled={busy || accepted}
              variant="outline"
              className="gap-1.5"
            >
              <Check className="size-4" />{" "}
              {accepted ? "Added to tasks" : "Add all to today’s tasks"}
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

function RevenueGrowthCard({ hub, today }: { hub: FinanceHubPayload; today: string }) {
  const month = today.slice(0, 7);
  const monthTxns = hub.transactions.filter((t) => monthKeyFromTimestamp(t.timestamp) === month);
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
            <div key={label} className="flex gap-3 rounded-md border border-border/60 p-3">
              <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
              <div>
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">{text}</div>
              </div>
            </div>
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

function Stat({
  label,
  value,
  tone,
  hero,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
  hero?: boolean;
}) {
  return (
    <Card className={hero ? "border-primary/40 bg-primary/[0.03]" : undefined}>
      <CardContent className="pt-4">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div
          className={`mt-1 font-semibold tabular-nums ${hero ? "text-3xl" : "text-2xl"} ${
            tone === "up"
              ? "text-green-600 dark:text-green-500"
              : tone === "down"
                ? "text-destructive"
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
  target,
  targetPct,
  goal = "spend",
  txns = [],
  recurringItems = [],
  onToggleExclude,
}: {
  label: string;
  actual: number;
  target: number;
  targetPct: number;
  goal?: "spend" | "save";
  txns?: Transaction[];
  recurringItems?: BudgetRecurringItem[];
  onToggleExclude?: (id: string, excluded: boolean) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const ratio = target > 0 ? actual / target : 0;
  const pct = Math.min(100, Math.round(ratio * 100));
  const remaining = target - actual;

  // Three-state color tuned to the goal direction. For spend buckets (needs/
  // wants) lower is better; for savings, hitting/exceeding the target is the win.
  const state: "good" | "warn" | "bad" =
    goal === "save"
      ? ratio >= 1
        ? "good"
        : ratio >= 0.8
          ? "warn"
          : "bad"
      : ratio > 1.02
        ? "bad"
        : ratio >= 0.9
          ? "warn"
          : "good";
  const barColor =
    state === "bad" ? "bg-destructive" : state === "warn" ? "bg-amber-500" : "bg-emerald-500";

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
    (sum, item) => sum + (item.seenThisMonth ? 0 : item.monthlyAmount),
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
        <div className="h-2 w-full overflow-hidden rounded bg-muted">
          <div className={`h-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
        </div>
        <div className={`mt-1 text-right text-xs tabular-nums ${noteColor}`}>{note}</div>
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
                  {item.seenThisMonth ? " · seen in statements" : " · from Recurring tab"}
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
                  <div className="tabular-nums text-muted-foreground">
                    {new Date(t.timestamp).toLocaleDateString()}
                  </div>
                </div>
                <span
                  className={`shrink-0 tabular-nums ${excluded ? "text-muted-foreground line-through" : ""}`}
                >
                  {fmtMoney(Math.abs(t.amount))}
                </span>
                <button
                  type="button"
                  onClick={() => onToggleExclude?.(t.id, !excluded)}
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${
                    excluded
                      ? "border-border text-muted-foreground hover:bg-muted"
                      : "border-border/60 text-muted-foreground hover:bg-muted"
                  }`}
                  title={excluded ? "Count this in the plan again" : "Mark as a one-time charge"}
                >
                  {excluded ? "Include" : "One-time"}
                </button>
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
