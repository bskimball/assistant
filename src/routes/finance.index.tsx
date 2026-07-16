import { createFileRoute } from "@tanstack/react-router";
import { Reveal } from "@/components/motion";
import { OverviewTab } from "@/components/finance/overview";
import { useFinanceWorkspace } from "@/components/finance/workspace-context";

export const Route = createFileRoute("/finance/")({
  component: FinanceOverviewPage,
});

function FinanceOverviewPage() {
  const { hub, today, advice, adviceLoading, reload, flash } = useFinanceWorkspace();
  return (
    <Reveal>
      <OverviewTab
        hub={hub}
        today={today}
        adviceItems={advice?.items ?? []}
        adviceLoading={adviceLoading}
        onChange={reload}
        flash={flash}
      />
    </Reveal>
  );
}
