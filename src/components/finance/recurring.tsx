import { MonthNav } from "@/components/finance/shared";
import { fmtMoney } from "@/components/finance/shared";
import type { FinanceTabProps } from "@/components/finance/shared";
import { useState } from "react";
import {
  Repeat,
  Plus,
  RefreshCw,
  Check,
  X,
  AlertTriangle,
  Sparkles,
  ChevronDown,
  Trash2,
  Landmark,
  Receipt,
  Pencil,
  Banknote,
  Circle,
  CheckCircle2,
  ListChecks,
  Link2,
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
import {
  detectSubscriptions,
  saveSubscriptions,
  rescanRecurringMatches,
  linkRecurringCharge,
  unlinkRecurringCharge,
  markRecurringPaid,
  unmarkRecurringPaid,
  applyRecurringInsight,
} from "@/server/finance";
import {
  todayISO,
  subscriptionMonthlyCost,
  recurringKindOf,
  recurringBudgetBucket,
  isCuttableSubscription,
  loanPayoffMonths,
  cleanMerchantName,
  type CategoryGroup,
  type RecurringKind,
  type Subscription,
  type Transaction,
} from "@/lib/domain";
import {
  amountWithinRecurringTolerance,
  recurringItemsForMonth,
  recurringMatchesTransaction,
  recurringNamesShareToken,
  simulateDebtPayoff,
  transactionsBeforeMonth,
  transactionsForMonth,
  type BudgetRecurringItem,
  type RecurringInsight,
} from "@/lib/finance-math";
import {
  CADENCE_ABBR,
  CollapsibleCard,
  GROUP_LABELS,
  InfoHint,
  MiniStat,
  Stat,
  fmtDate,
  formatMonthLabel,
  shiftMonth,
} from "@/components/finance/shared";

type SpendGroup = "needs" | "wants" | "savings";

function groupOf(s: Pick<Subscription, "group">): SpendGroup {
  return s.group === "needs" || s.group === "savings" ? s.group : "wants";
}

// The kind of obligation controls which section a row lives in. The budget
// bucket is separate: loans are always Needs, bills can be Needs or Wants, and
// subscriptions can be Wants or recurring Savings.
const KIND_OPTIONS: {
  key: RecurringKind;
  label: string;
  activeClass: string;
}[] = [
  {
    key: "loan",
    label: "Loan",
    activeClass: "bg-background text-warning shadow-sm",
  },
  {
    key: "bill",
    label: "Bill",
    activeClass: "bg-background text-info shadow-sm",
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
                  ? "bg-background text-info shadow-sm"
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
                  ? "bg-background text-success shadow-sm"
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
    <Card className="border-warning/30 bg-warning/10">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="size-4 text-warning" /> Recurring updates
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
              <li key={key} className="zen-surface-nested p-3 text-sm">
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
  const chargeStatusClass = chargeStatus?.tone === "paid" ? "text-success" : "text-warning";

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
        ? {
            balance: Number(editBalance) || undefined,
            apr: Number(editApr) || undefined,
          }
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
                  onSaveEdit(s, {
                    matchHints: (s.matchHints ?? []).filter((h) => h !== hint),
                  })
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
            <div className="text-[11px] tabular-nums text-warning">
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
  {
    kind: "subscription",
    label: "Subscriptions & savings",
    hint: "Wants/Savings",
    Icon: Repeat,
  },
];

// One verification row: matched charge (success check + paid detail) or an
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
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
          ) : (
            <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />
          )}
          <div className="min-w-0">
            <div className="truncate">{cleanMerchantName(item.name)}</div>
            {item.seenThisMonth && item.matchedTxn ? (
              <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-success">
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
                      className="h-5 gap-1 rounded-md px-1.5 text-[10px] text-info"
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
                      className="h-5 gap-1 rounded-md px-1.5 text-[10px] text-info"
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
          <span className="text-[10px] font-medium text-muted-foreground">Link charge</span>
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
    selectedMonth,
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
        <span className={allClear ? "text-success" : "text-warning"}>
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
                  allClear ? "flex items-center gap-1.5 font-medium text-success" : "font-medium"
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
                className="h-full rounded-full bg-success transition-[width] duration-300 ease-out"
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
                  <div className="mb-1 text-[10px] font-medium text-muted-foreground">
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
                  <div className="mb-1 text-[10px] font-medium text-muted-foreground">Matched</div>
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
      className="border-warning/20 bg-linear-to-br from-warning/6 to-card"
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

export function RecurringTab({ hub, onChange, flash }: FinanceTabProps) {
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
    currentMonth,
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
        ? {
            balance: Number(balance) || undefined,
            apr: Number(apr) || undefined,
          }
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
                      <h3 className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
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
