import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Banknote,
  LineChart,
  Wallet2,
  Info,
  type LucideIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  cleanMerchantName,
  type CategoryGroup,
  type RecurringKind,
  type Subscription,
  type Transaction,
  type AccountBalance,
} from "@/lib/domain";
import { type BudgetBucket, type BudgetRecurringItem } from "@/lib/finance-math";

export type FinanceTabProps = {
  hub: import("@/server/finance").FinanceHubPayload;
  onChange: () => Promise<void>;
  flash: (msg: string, ms?: number) => void;
};

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function fmtMoney(n: number): string {
  return usdFormatter.format(Number.isFinite(n) ? n : 0);
}

export function CollapsibleCard({
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

export function InfoHint({
  children,
  label = "More info",
}: {
  children: ReactNode;
  label?: string;
}) {
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

export function moneyInputValue(n: number | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "";
}

export function fmtDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function fmtISODate(date: string): string {
  return new Date(date + "T00:00:00").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// Month math on "YYYY-MM" keys. Uses local Date only for calendar arithmetic on
// the year/month integers (day pinned to 1), so there's no timezone day-shift.
export function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function formatMonthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

export function isPaycheckLike(t: Transaction): boolean {
  const text = `${t.category || ""} ${t.notes || ""}`.toLowerCase();
  return ["payroll", "adp", "direct dep", "salary", "paycheck"].some((k) => text.includes(k));
}

export type ImportedAccountSummary = {
  account: string;
  count: number;
  lastSeen: number;
};

export function summarizeImportedAccounts(transactions: Transaction[]): ImportedAccountSummary[] {
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

export function recurringAdditionsSummary(additions: Record<BudgetBucket, number>): string {
  return (["needs", "wants", "savings"] as const)
    .filter((bucket) => additions[bucket] > 0)
    .map((bucket) => `${bucket} ${fmtMoney(additions[bucket])}`)
    .join(", ");
}

export const GROUP_LABELS: Record<CategoryGroup, string> = {
  needs: "Needs",
  wants: "Wants",
  savings: "Savings",
  income: "Income",
  transfer: "Transfer",
};

export const CADENCE_ABBR: Record<Subscription["cadence"], string> = {
  weekly: "wk",
  monthly: "mo",
  annual: "yr",
};

export function recurringKindLabel(kind: RecurringKind): string {
  return kind === "loan" ? "Loan" : kind === "bill" ? "Bill" : "Subscription";
}

/* ---------------- Subscriptions ---------------- */

// The three spendable 50/30/20 buckets a recurring item can land in. Unset

export type SpendGroup = "needs" | "wants" | "savings";

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

export function GroupPicker({
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

export function MonthNav({
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

export function MiniStat({
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
      <div className="text-[10px] text-muted-foreground">{label}</div>
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

export type AccountType = "cash" | "credit" | "investments" | "other";

export const ACCOUNT_GROUP_META: {
  type: AccountType;
  label: string;
  Icon: typeof Wallet2;
}[] = [
  { type: "cash", label: "Cash", Icon: Wallet2 },
  { type: "credit", label: "Credit", Icon: CreditCard },
  { type: "investments", label: "Investments", Icon: LineChart },
  { type: "other", label: "Other", Icon: Banknote },
];

// Bucket an account by a case-insensitive keyword match on its name/alias.
export function inferAccountType(name: string): AccountType {
  const s = name.toLowerCase();
  if (/(checking|savings|bank)/.test(s)) return "cash";
  if (/(credit|card|platinum)/.test(s)) return "credit";
  if (/(robinhood|stock|crypto|bitcoin|401k|brokerage|ira)/.test(s)) return "investments";
  return "other";
}

export function cashLikeBalance(accounts: AccountBalance[]): number {
  return accounts
    .filter((account) => inferAccountType(account.account) === "cash" && account.amount > 0)
    .reduce((sum, account) => sum + account.amount, 0);
}

export const SOURCE_BADGE_META: Record<
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
export function SourceBadge({ source }: { source?: Transaction["source"] }) {
  const meta = SOURCE_BADGE_META[source ?? "manual"];
  return (
    <span
      className={`inline-flex h-4 items-center rounded border px-1 text-[9px] font-medium uppercase leading-none tracking-wide ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

export const GROUP_CHIP_CLASS: Record<CategoryGroup, string> = {
  needs: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  wants: "border-border bg-muted/50 text-muted-foreground",
  savings: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  income: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  transfer: "border-border bg-muted/50 text-muted-foreground",
};

// 50/30/20 bucket chip shown on activity rows when a group is assigned.
export function GroupChip({ group }: { group: CategoryGroup }) {
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
export function TxnSubline({
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

export function Stat({
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
        <div className="text-[11px] text-muted-foreground">{label}</div>
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

export function BudgetBar({
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
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  const statementPct =
    target > 0 ? Math.max(0, Math.min(100, Math.round((statementActual / target) * 100))) : 0;
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
          <div
            className={`absolute inset-y-0 left-0 transition-[width] duration-300 ease-out ${barColor}`}
            style={{ width: `${statementPct}%` }}
          />
          {plannedPct > 0 && (
            <div
              className={`absolute inset-y-0 opacity-40 transition-[left,width] duration-300 ease-out ${plannedBarColor}`}
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
