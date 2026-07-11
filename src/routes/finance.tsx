import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Reveal } from "@/components/motion";
import { Lightbulb, PiggyBank, Repeat, TrendingUp, Wallet } from "lucide-react";
import { financeAdviceQuery, financeHubQuery, queryKeys } from "@/lib/queries";
import { todayISO } from "@/lib/domain";
import { fmtMoney } from "@/components/finance/shared";
import { OverviewTab } from "@/components/finance/overview";
import { BudgetTab } from "@/components/finance/budget";
import { RecurringTab } from "@/components/finance/recurring";
import { InvestmentsTab } from "@/components/finance/investments";
import { GrowTab } from "@/components/finance/grow";

type TabKey = "overview" | "budget" | "recurring" | "investments" | "grow";

const TABS: { key: TabKey; label: string; Icon: typeof Wallet }[] = [
  { key: "overview", label: "Overview", Icon: Wallet },
  { key: "budget", label: "Budget", Icon: PiggyBank },
  { key: "recurring", label: "Recurring", Icon: Repeat },
  { key: "investments", label: "Investments", Icon: TrendingUp },
  { key: "grow", label: "Grow", Icon: Lightbulb },
];

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
