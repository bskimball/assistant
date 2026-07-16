import { createFileRoute } from "@tanstack/react-router";
import { Reveal } from "@/components/motion";
import { InvestmentsTab } from "@/components/finance/investments";
import { useFinanceWorkspace } from "@/components/finance/workspace-context";

export const Route = createFileRoute("/finance/investments")({
  component: FinanceInvestmentsPage,
});

function FinanceInvestmentsPage() {
  const { hub, today, reload, flash } = useFinanceWorkspace();
  return (
    <Reveal>
      <InvestmentsTab hub={hub} today={today} onChange={reload} flash={flash} />
    </Reveal>
  );
}
