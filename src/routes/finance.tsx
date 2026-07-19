import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Collapse } from "@/components/motion";
import { PageHeader } from "@/components/page-header";
import { WorkspaceShell } from "@/components/workspace-shell";
import { fmtMoney } from "@/components/finance/shared";
import { FinanceWorkspaceContext } from "@/components/finance/workspace-context";
import { RouteError } from "@/components/route-error";
import { financeAdviceQuery, financeHubQuery, queryKeys } from "@/lib/queries";
import { todayISO } from "@/lib/domain";

const LEGACY_TAB_PATHS = {
  overview: "/finance",
  budget: "/finance/budget",
  recurring: "/finance/recurring",
  subscriptions: "/finance/recurring",
  investments: "/finance/investments",
  grow: "/finance/grow",
} as const;

type LegacyTab = keyof typeof LEGACY_TAB_PATHS;

export const Route = createFileRoute("/finance")({
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === "string" ? search.tab : undefined,
  }),
  beforeLoad: ({ search, location }) => {
    // Migrate old ?tab= links to child routes once, then strip the param.
    if (location.pathname !== "/finance" || !search.tab) return;
    const key = search.tab as LegacyTab;
    const to = LEGACY_TAB_PATHS[key];
    if (!to) {
      throw redirect({ to: "/finance", search: {}, replace: true });
    }
    throw redirect({ to, search: {}, replace: true });
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
  errorComponent: RouteError,
  component: FinanceLayout,
});

function FinanceLayout() {
  const today = todayISO();
  const month = today.slice(0, 7);
  const { data: hub = null, isPending: loading } = useQuery(financeHubQuery(today));
  const { data: advice = null, isPending: adviceLoading } = useQuery(financeAdviceQuery(today));
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    <WorkspaceShell
      workspace="money"
      header={
        <PageHeader
          eyebrow="Money"
          title="Finance Hub"
          voice="Money is a tool. Keep it quiet and clear."
          className="mb-8"
        >
          <div className="zen-card px-3 py-2 text-right">
            <div className="text-[10px] text-muted-foreground">Net worth</div>
            <div className="text-2xl font-semibold tabular-nums">{fmtMoney(netWorth)}</div>
          </div>
        </PageHeader>
      }
    >
      <Collapse open={Boolean(status)}>
        <div className="zen-card mb-4 px-3 py-2 text-sm text-muted-foreground">{status}</div>
      </Collapse>

      {loading && !hub ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
      ) : !hub ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          Couldn’t load your finances.
        </div>
      ) : (
        <FinanceWorkspaceContext.Provider
          value={{
            hub,
            today,
            month,
            advice,
            adviceLoading,
            reload,
            flash,
          }}
        >
          <Outlet />
        </FinanceWorkspaceContext.Provider>
      )}
    </WorkspaceShell>
  );
}
