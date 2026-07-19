import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowCounterClockwiseIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Reveal } from "@/components/motion";
import { useFinanceWorkspace } from "@/components/finance/workspace-context";
import {
  SourceBadge,
  fmtDate,
  fmtMoney,
  formatMonthLabel,
  summarizeImportedAccounts,
} from "@/components/finance/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cleanMerchantName, type Transaction } from "@/lib/domain";
import { restoreTransaction } from "@/server/finance";

const PAGE_SIZE = 50;

type DatePreset = "this-month" | "last-month" | "last-90" | "all";
type SourceFilter = "all" | "sync" | "import" | "manual";

export const Route = createFileRoute("/finance/transactions")({
  validateSearch: (search: Record<string, unknown>): { q?: string; deleted?: "1" } => ({
    q: typeof search.q === "string" && search.q.trim() ? search.q : undefined,
    deleted: search.deleted === "1" ? "1" : undefined,
  }),
  component: FinanceTransactionsPage,
});

function FinanceTransactionsPage() {
  const { hub, reload, flash } = useFinanceWorkspace();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [query, setQuery] = useState(search.q ?? "");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [account, setAccount] = useState<string | null>(null);
  const [source, setSource] = useState<SourceFilter>("all");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const showDeleted = search.deleted === "1";

  useEffect(() => {
    setQuery(search.q ?? "");
  }, [search.q]);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized === (search.q ?? "")) return;
    const timer = window.setTimeout(() => {
      void navigate({
        search: { q: normalized || undefined, deleted: search.deleted },
        replace: true,
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [navigate, query, search.deleted, search.q]);

  const availableTransactions = useMemo(
    () => (showDeleted ? [...hub.transactions, ...hub.deletedTransactions] : hub.transactions),
    [hub.deletedTransactions, hub.transactions, showDeleted],
  );
  const accountChips = useMemo(
    () => summarizeImportedAccounts(availableTransactions),
    [availableTransactions],
  );

  const filtered = useMemo(() => {
    const normalizedQuery = (search.q ?? "").trim().toLowerCase();
    const accountKey = account?.toLowerCase();
    const min = amountMin === "" ? null : Number(amountMin);
    const max = amountMax === "" ? null : Number(amountMax);
    const range = dateRange(datePreset);

    return [...availableTransactions]
      .filter((transaction) => {
        if (normalizedQuery) {
          const searchable =
            `${transaction.category ?? ""} ${transaction.notes ?? ""} ${transaction.account ?? ""}`.toLowerCase();
          if (!searchable.includes(normalizedQuery)) return false;
        }
        if (accountKey && transaction.account?.trim().toLowerCase() !== accountKey) return false;
        if (source !== "all" && (transaction.source ?? "manual") !== source) return false;
        if (range && (transaction.timestamp < range.start || transaction.timestamp >= range.end)) {
          return false;
        }
        if (min !== null && Number.isFinite(min) && transaction.amount < min) return false;
        if (max !== null && Number.isFinite(max) && transaction.amount > max) return false;
        return true;
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [account, amountMax, amountMin, availableTransactions, datePreset, search.q, source]);

  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [account, amountMax, amountMin, datePreset, search.q, showDeleted, source]);

  const selectedAccountSummary = useMemo(() => {
    if (!account || filtered.length === 0) return null;
    return {
      count: filtered.length,
      first: filtered[filtered.length - 1].timestamp,
      last: filtered[0].timestamp,
    };
  }, [account, filtered]);

  const shownGroups = useMemo(() => {
    let remaining = visible;
    return groupByMonth(filtered)
      .map((group) => {
        const shownTransactions = group.transactions.slice(0, Math.max(remaining, 0));
        remaining -= shownTransactions.length;
        return { ...group, shownTransactions };
      })
      .filter((group) => group.shownTransactions.length > 0);
  }, [filtered, visible]);

  async function restore(transaction: Transaction) {
    setRestoringId(transaction.id);
    try {
      await restoreTransaction({ data: { id: transaction.id } });
      await reload();
      flash(`Restored ${cleanMerchantName(transaction.category || "transaction")}.`);
    } catch (error) {
      flash(error instanceof Error ? error.message : "Couldn’t restore that transaction.");
    } finally {
      setRestoringId(null);
    }
  }

  function toggleDeleted() {
    void navigate({
      search: { q: search.q, deleted: showDeleted ? undefined : "1" },
      replace: true,
    });
  }

  return (
    <Reveal>
      <div className="space-y-4">
        <div>
          <h2 className="text-balance text-xl font-semibold tracking-tight">Transactions</h2>
          <p className="mt-1 text-pretty text-sm text-muted-foreground">
            Search, verify, and review every synced, imported, and manual ledger entry.
          </p>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Find transactions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative">
              <MagnifyingGlassIcon
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                weight="duotone"
              />
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search merchant, notes, or account"
                aria-label="Search transactions"
                className="pl-8"
              />
            </div>

            <FilterSection label="Date">
              {(
                [
                  ["this-month", "This month"],
                  ["last-month", "Last month"],
                  ["last-90", "Last 90 days"],
                  ["all", "All"],
                ] as const
              ).map(([value, label]) => (
                <ChoiceChip
                  key={value}
                  label={label}
                  active={datePreset === value}
                  onClick={() => setDatePreset(value)}
                />
              ))}
            </FilterSection>

            <FilterSection label="Account">
              <ChoiceChip
                label="All"
                count={availableTransactions.length}
                active={account === null}
                onClick={() => setAccount(null)}
              />
              {accountChips.map((item) => (
                <ChoiceChip
                  key={item.account}
                  label={item.account}
                  count={item.count}
                  active={account?.toLowerCase() === item.account.toLowerCase()}
                  onClick={() => setAccount(item.account)}
                />
              ))}
            </FilterSection>

            <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
              <FilterSection label="Source">
                {(
                  [
                    ["all", "All"],
                    ["sync", "Synced"],
                    ["import", "Imported"],
                    ["manual", "Manual"],
                  ] as const
                ).map(([value, label]) => (
                  <ChoiceChip
                    key={value}
                    label={label}
                    active={source === value}
                    onClick={() => setSource(value)}
                  />
                ))}
              </FilterSection>

              <div className="flex items-end gap-2">
                <label className="grid gap-1 text-xs text-muted-foreground">
                  Min amount
                  <Input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    value={amountMin}
                    onChange={(event) => setAmountMin(event.target.value)}
                    placeholder="No min"
                    className="w-28 tabular-nums"
                  />
                </label>
                <label className="grid gap-1 text-xs text-muted-foreground">
                  Max amount
                  <Input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    value={amountMax}
                    onChange={(event) => setAmountMax(event.target.value)}
                    placeholder="No max"
                    className="w-28 tabular-nums"
                  />
                </label>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
              <span className="text-xs text-muted-foreground">
                <span className="tabular-nums">{filtered.length.toLocaleString()}</span> matching
                transaction{filtered.length === 1 ? "" : "s"}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={showDeleted}
                onClick={toggleDeleted}
                className="inline-flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <span
                  aria-hidden
                  className={`relative h-5 w-9 rounded-full transition-colors ${showDeleted ? "bg-primary" : "bg-muted-foreground/25"}`}
                >
                  <span
                    className={`absolute top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform ${showDeleted ? "translate-x-[18px]" : "translate-x-0.5"}`}
                  />
                </span>
                Show deleted
                {hub.deletedTransactions.length > 0 && (
                  <span className="tabular-nums text-xs">({hub.deletedTransactions.length})</span>
                )}
              </button>
            </div>
          </CardContent>
        </Card>

        {selectedAccountSummary && (
          <p className="px-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{account}</span> ·{" "}
            <span className="tabular-nums">{selectedAccountSummary.count}</span> transaction
            {selectedAccountSummary.count === 1 ? "" : "s"} · first{" "}
            <span className="tabular-nums">{fmtDate(selectedAccountSummary.first)}</span> · last{" "}
            <span className="tabular-nums">{fmtDate(selectedAccountSummary.last)}</span>
          </p>
        )}

        {shownGroups.length > 0 ? (
          <div className="space-y-4">
            {shownGroups.map((group) => (
              <Card key={group.month}>
                <CardHeader className="flex-row items-center justify-between gap-3 pb-2">
                  <CardTitle className="text-base">{formatMonthLabel(group.month)}</CardTitle>
                  <div className="text-right text-xs text-muted-foreground">
                    <span className="font-medium tabular-nums text-foreground">
                      {fmtMoney(group.subtotal)}
                    </span>
                    <span>
                      {" "}
                      · {group.transactions.length.toLocaleString()} transaction
                      {group.transactions.length === 1 ? "" : "s"}
                    </span>
                  </div>
                </CardHeader>
                <CardContent>
                  <ul className="divide-y divide-border">
                    {group.shownTransactions.map((transaction) => (
                      <TransactionRow
                        key={transaction.id}
                        transaction={transaction}
                        restoring={restoringId === transaction.id}
                        onRestore={() => restore(transaction)}
                      />
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}

            {visible < filtered.length && (
              <div className="flex justify-center">
                <Button variant="outline" onClick={() => setVisible((count) => count + PAGE_SIZE)}>
                  Show 50 more
                  <span className="text-muted-foreground tabular-nums">
                    ({(filtered.length - visible).toLocaleString()} left)
                  </span>
                </Button>
              </div>
            )}
          </div>
        ) : (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              No transactions match these filters.
            </CardContent>
          </Card>
        )}
      </div>
    </Reveal>
  );
}

function FilterSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</legend>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </fieldset>
  );
}

function ChoiceChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      <span className="truncate">{label}</span>
      {typeof count === "number" && (
        <span className={`tabular-nums ${active ? "text-primary-foreground/75" : "opacity-70"}`}>
          {count.toLocaleString()}
        </span>
      )}
    </button>
  );
}

function TransactionRow({
  transaction,
  restoring,
  onRestore,
}: {
  transaction: Transaction;
  restoring: boolean;
  onRestore: () => void;
}) {
  const deleted = Boolean(transaction.deletedAt);
  const rawDescriptor = transaction.category?.trim() || "No bank descriptor";
  const merchant = transaction.category ? cleanMerchantName(transaction.category) : "Transaction";

  return (
    <li
      className={`grid gap-2 py-3 text-sm sm:grid-cols-[5rem_minmax(0,1fr)_auto] sm:items-center ${deleted ? "opacity-55" : ""}`}
    >
      <span
        className={`text-xs tabular-nums text-muted-foreground ${deleted ? "line-through" : ""}`}
      >
        {fmtDate(transaction.timestamp)}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`truncate font-medium ${deleted ? "line-through" : ""}`}
            title={rawDescriptor}
          >
            {merchant}
          </span>
          <SourceBadge source={transaction.source} />
          {transaction.recurringId && (
            <span className="inline-flex h-4 items-center rounded border border-border bg-muted/40 px-1 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              recurring
            </span>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span className="max-w-full truncate" title={rawDescriptor}>
            {rawDescriptor}
          </span>
          {transaction.account && (
            <>
              <span aria-hidden>·</span>
              <span>{transaction.account}</span>
            </>
          )}
        </div>
        {deleted && (
          <div className="mt-1 text-xs text-destructive">
            deleted{transaction.deletedReason ? ` · ${transaction.deletedReason}` : ""}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 sm:justify-end">
        <span
          className={`font-medium tabular-nums ${
            transaction.amount < 0 ? "text-destructive" : "text-success"
          } ${deleted ? "line-through" : ""}`}
        >
          {transaction.amount < 0 ? "−" : "+"}
          {fmtMoney(Math.abs(transaction.amount))}
        </span>
        {deleted && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={restoring}
            onClick={onRestore}
            className="gap-1"
          >
            <ArrowCounterClockwiseIcon className="size-3.5" weight="duotone" />
            {restoring ? "Restoring…" : "Restore"}
          </Button>
        )}
      </div>
    </li>
  );
}

function dateRange(preset: DatePreset): { start: number; end: number } | null {
  if (preset === "all") return null;
  const now = new Date();
  if (preset === "this-month") {
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(),
    };
  }
  if (preset === "last-month") {
    return {
      start: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(),
      end: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
    };
  }
  return {
    start: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 89).setHours(0, 0, 0, 0),
    end: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).setHours(0, 0, 0, 0),
  };
}

function groupByMonth(transactions: Transaction[]) {
  const groups = new Map<string, Transaction[]>();
  for (const transaction of transactions) {
    const date = new Date(transaction.timestamp);
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const group = groups.get(month);
    if (group) group.push(transaction);
    else groups.set(month, [transaction]);
  }
  return [...groups.entries()].map(([month, monthTransactions]) => ({
    month,
    transactions: monthTransactions,
    subtotal: monthTransactions.reduce((sum, transaction) => sum + transaction.amount, 0),
  }));
}
