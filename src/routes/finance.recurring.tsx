import { createFileRoute } from "@tanstack/react-router";
import { Reveal } from "@/components/motion";
import { RecurringTab } from "@/components/finance/recurring";
import { useFinanceWorkspace } from "@/components/finance/workspace-context";

export const Route = createFileRoute("/finance/recurring")({
  component: FinanceRecurringPage,
});

function FinanceRecurringPage() {
  const { hub, reload, flash } = useFinanceWorkspace();
  return (
    <Reveal>
      <RecurringTab hub={hub} onChange={reload} flash={flash} />
    </Reveal>
  );
}
