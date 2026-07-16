import { createFileRoute } from "@tanstack/react-router";
import { Reveal } from "@/components/motion";
import { BudgetTab } from "@/components/finance/budget";
import { useFinanceWorkspace } from "@/components/finance/workspace-context";

export const Route = createFileRoute("/finance/budget")({
  component: FinanceBudgetPage,
});

function FinanceBudgetPage() {
  const { hub, month, reload, flash } = useFinanceWorkspace();
  return (
    <Reveal>
      <BudgetTab hub={hub} month={month} onChange={reload} flash={flash} />
    </Reveal>
  );
}
