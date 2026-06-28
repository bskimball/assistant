import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";
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
  Target,
  BriefcaseBusiness,
  CalendarCheck,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveDailyFinance } from "@/server/domain";
import {
  loadFinanceHub,
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
  isBillSubscription,
  cleanMerchantName,
  summarizeCashFlow,
  DEFAULT_BUDGET_TARGETS,
  type CategoryGroup,
  type Subscription,
  type Transaction,
  type Position,
  type FinanceAdviceItem,
} from "@/lib/domain";

type TabKey = "overview" | "budget" | "subscriptions" | "investments" | "grow";

const TABS: { key: TabKey; label: string; Icon: typeof Wallet }[] = [
  { key: "overview", label: "Overview", Icon: Wallet },
  { key: "budget", label: "Budget", Icon: PiggyBank },
  { key: "subscriptions", label: "Subscriptions", Icon: Repeat },
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
  component: FinancePage,
});

function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
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

function FinancePage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const tab: TabKey = search.tab || "overview";
  const today = todayISO();
  const month = today.slice(0, 7);

  const [hub, setHub] = useState<FinanceHubPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await loadFinanceHub({ data: today });
      setHub(data);
    } catch (e) {
      console.error("[finance] load failed", e);
    } finally {
      setLoading(false);
    }
  }, [today]);

  useEffect(() => {
    void load();
  }, [load]);

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
          <>
            {tab === "overview" && (
              <OverviewTab hub={hub} today={today} onChange={load} flash={flash} />
            )}
            {tab === "budget" && (
              <BudgetTab hub={hub} month={month} onChange={load} flash={flash} />
            )}
            {tab === "subscriptions" && (
              <SubscriptionsTab hub={hub} onChange={load} flash={flash} />
            )}
            {tab === "investments" && (
              <InvestmentsTab hub={hub} today={today} onChange={load} flash={flash} />
            )}
            {tab === "grow" && <GrowTab hub={hub} today={today} flash={flash} />}
          </>
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

  const monthTxns = hub.transactions.filter(
    (t) => new Date(t.timestamp).toISOString().slice(0, 7) === today.slice(0, 7),
  );
  // Imported income only captures deposits to the accounts you've imported, so a
  // second paycheck landing in another account is missed. Prefer the monthly
  // take-home you set on the Budget tab (your full after-tax pay) when available.
  const takeHome = hub.budget?.monthlyTakeHome ?? 0;
  const usePlannedIncome = takeHome > 0;
  // Shared definition so Today / Finance / Analytics agree (transfers excluded).
  const { income, spend, cashFlow } = summarizeCashFlow(monthTxns, takeHome);

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
        <Stat label="Spending (mo)" value={fmtMoney(spend)} />
      </div>

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
                {accounts.map((a, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between border-b border-border/40 py-1.5 last:border-0"
                  >
                    <span>{a.account}</span>
                    <span className="tabular-nums text-muted-foreground">{fmtMoney(a.amount)}</span>
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
            Balances upsert by name. Update them whenever you check your accounts.
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
  const [takeHome, setTakeHome] = useState(String(hub.budget?.monthlyTakeHome ?? ""));
  const [busy, setBusy] = useState(false);
  const [showStatements, setShowStatements] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [institution, setInstitution] = useState(INSTITUTIONS[0]);

  const targets = hub.budget?.targets ?? DEFAULT_BUDGET_TARGETS;
  const th = Number(takeHome) || hub.budget?.monthlyTakeHome || 0;

  const monthTxns = hub.transactions.filter(
    (t) => new Date(t.timestamp).toISOString().slice(0, 7) === month,
  );
  // Per-bucket totals + the transactions behind each bar. One-time charges the
  // user has marked (excludeFromBudget) are kept in the lists but greyed out and
  // left out of the totals, so a single big legal/medical bill doesn't blow the
  // monthly 50/30/20 comparison.
  const buckets = { needs: 0, wants: 0, savings: 0 };
  const bucketTxns: Record<"needs" | "wants" | "savings", Transaction[]> = {
    needs: [],
    wants: [],
    savings: [],
  };
  let excludedTotal = 0;
  for (const t of monthTxns) {
    const b = spendBucketOf(t.categoryGroup);
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

  // Fixed bills (mortgage, car, …) feed Needs. Include each bill's monthly
  // cost only if no matching charge has posted this month — so importing a
  // statement that already contains the payment doesn't double-count it.
  const activeBills = hub.subscriptions.filter(
    (s) => isBillSubscription(s) && s.status === "active",
  );
  const plannedNeeds = activeBills.reduce((sum, b) => {
    const paid = monthTxns.some(
      (t) =>
        t.amount < 0 && Math.abs(Math.abs(t.amount) - b.amount) <= Math.max(1, b.amount * 0.05),
    );
    return paid ? sum : sum + subscriptionMonthlyCost(b);
  }, 0);
  buckets.needs += plannedNeeds;

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
      flash(`Imported ${res.added} new transactions (${res.skipped} duplicates skipped).`);
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
          <CardTitle className="flex items-center justify-between text-base">
            <span>This month vs plan</span>
            <span className="text-xs font-normal text-muted-foreground">{month}</span>
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
                  onToggleExclude={toggleExclude}
                />
              ))}
              {plannedNeeds > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Needs includes {fmtMoney(plannedNeeds)} of fixed bills not yet charged this month.
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

      <BillsCard hub={hub} onChange={onChange} flash={flash} />

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

/* ---------------- Fixed bills (Needs) ---------------- */

const CADENCE_ABBR: Record<Subscription["cadence"], string> = {
  weekly: "wk",
  monthly: "mo",
  annual: "yr",
};

function BillsCard({ hub, onChange, flash }: TabProps) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<Subscription["cadence"]>("monthly");
  const [busy, setBusy] = useState(false);

  const bills = hub.subscriptions.filter((s) => isBillSubscription(s) && s.status === "active");
  const monthlyTotal = bills.reduce((s, b) => s + subscriptionMonthlyCost(b), 0);

  async function persist(next: Subscription[]) {
    await saveSubscriptions({ data: { subscriptions: next } });
    await onChange();
  }

  async function addBill(e: React.FormEvent) {
    e.preventDefault();
    const amt = Number(amount);
    if (!name.trim() || !Number.isFinite(amt) || amt <= 0) return;
    setBusy(true);
    try {
      const bill: Subscription = {
        id: `sub-${Date.now()}`,
        createdAt: Date.now(),
        name: name.trim(),
        amount: amt,
        cadence,
        status: "active",
        source: "manual",
        group: "needs",
      };
      await persist([...hub.subscriptions, bill]);
      setName("");
      setAmount("");
      flash("Bill added.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: Subscription) {
    setBusy(true);
    try {
      await persist(hub.subscriptions.filter((x) => x.id !== s.id));
      flash(`Removed ${s.name}.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>Fixed monthly bills</span>
          <span className="text-xs font-normal text-muted-foreground tabular-nums">
            {fmtMoney(monthlyTotal)}/mo
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-muted-foreground">
          Recurring obligations like your mortgage and car payment. These count toward your Needs
          budget above.
        </p>
        {bills.length > 0 && (
          <ul className="mb-3 divide-y divide-border">
            {bills.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1 truncate">{b.name}</div>
                <div className="text-xs text-muted-foreground tabular-nums">
                  {fmtMoney(b.amount)}/{CADENCE_ABBR[b.cadence]}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 text-xs text-muted-foreground"
                  onClick={() => remove(b)}
                  disabled={busy}
                >
                  <X className="size-3.5" /> Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={addBill} className="flex flex-wrap items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. Mortgage)"
            className="flex-1 min-w-[140px]"
            disabled={busy}
          />
          <Input
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Amount"
            className="w-28"
            disabled={busy}
          />
          <select
            value={cadence}
            onChange={(e) => setCadence(e.target.value as Subscription["cadence"])}
            className="h-9 rounded-md border bg-background px-2 text-sm"
            disabled={busy}
          >
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="annual">Annual</option>
          </select>
          <Button
            type="submit"
            size="sm"
            className="gap-1"
            disabled={busy || !name.trim() || !amount}
          >
            <Plus className="size-4" /> Add
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/* ---------------- Subscriptions ---------------- */

function SubscriptionsTab({ hub, onChange, flash }: TabProps) {
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<Subscription[] | null>(null);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<Subscription["cadence"]>("monthly");

  // Bills (mortgage, car, …) live under Budget; keep this tab to discretionary
  // subscriptions only so the totals here stay meaningful.
  const subs = hub.subscriptions
    .filter((s) => !isBillSubscription(s))
    // Active first, then by monthly cost descending so the biggest leak is on top.
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "active" ? -1 : 1;
      return subscriptionMonthlyCost(b) - subscriptionMonthlyCost(a);
    });
  const active = subs.filter((s) => s.status === "active");
  const monthlyTotal = active.reduce((s, x) => s + subscriptionMonthlyCost(x), 0);

  async function detect() {
    setBusy(true);
    flash("Scanning your transactions…");
    try {
      const res = await detectSubscriptions({ data: {} });
      setCandidates(res.candidates);
      flash(
        res.candidates.length
          ? `Found ${res.candidates.length} possible subscription(s).`
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
    flash(`Added ${c.name}.`);
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
    };
    await persist([...hub.subscriptions, sub]);
    setName("");
    setAmount("");
    flash("Subscription added.");
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Monthly" value={fmtMoney(monthlyTotal)} />
        <Stat label="Annual" value={fmtMoney(monthlyTotal * 12)} tone="down" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span>Active subscriptions</span>
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
            <ul className="divide-y divide-border">
              {subs.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div
                      className={`truncate ${s.status === "canceled" ? "line-through opacity-60" : ""}`}
                    >
                      {cleanMerchantName(s.name)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {fmtMoney(s.amount)}/
                      {s.cadence === "monthly" ? "mo" : s.cadence === "annual" ? "yr" : "wk"}
                      {s.source === "detected" ? " · detected" : ""}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 text-xs text-muted-foreground"
                    onClick={() => toggleCancel(s)}
                  >
                    {s.status === "active" ? (
                      <>
                        <X className="size-3.5" /> Cancel
                      </>
                    ) : (
                      <>
                        <Check className="size-3.5" /> Reactivate
                      </>
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sm text-muted-foreground">
              No subscriptions tracked. Detect them from imported statements or add manually below.
            </div>
          )}
        </CardContent>
      </Card>

      {candidates && candidates.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Detected — confirm to track</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {candidates.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{cleanMerchantName(c.name)}</div>
                    <div className="text-xs text-muted-foreground">
                      ~{fmtMoney(c.amount)}/
                      {c.cadence === "monthly" ? "mo" : c.cadence === "annual" ? "yr" : "wk"}
                    </div>
                  </div>
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
          <form onSubmit={addManual} className="flex flex-wrap items-center gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name (e.g. Netflix)"
              className="flex-1 min-w-[140px]"
            />
            <Input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount"
              className="w-28"
            />
            <select
              value={cadence}
              onChange={(e) => setCadence(e.target.value as Subscription["cadence"])}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="annual">Annual</option>
            </select>
            <Button type="submit" size="sm" className="gap-1" disabled={!name.trim() || !amount}>
              <Plus className="size-4" /> Add
            </Button>
          </form>
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
              <Card key={i}>
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
  onToggleExclude,
}: {
  label: string;
  actual: number;
  target: number;
  targetPct: number;
  goal?: "spend" | "save";
  txns?: Transaction[];
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
  const expandable = txns.length > 0 && !!onToggleExclude;
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
