import { createFileRoute } from "@tanstack/react-router";
import { Reveal } from "@/components/motion";
import { GrowTab } from "@/components/finance/grow";
import { useFinanceWorkspace } from "@/components/finance/workspace-context";

export const Route = createFileRoute("/finance/grow")({
  component: FinanceGrowPage,
});

function FinanceGrowPage() {
  const { hub, today, flash } = useFinanceWorkspace();
  return (
    <Reveal>
      <GrowTab hub={hub} today={today} flash={flash} />
    </Reveal>
  );
}
