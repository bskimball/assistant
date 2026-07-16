import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";
import { RouteError } from "@/components/route-error";
import { WorkspaceShell } from "@/components/workspace-shell";

export const Route = createFileRoute("/health")({
  errorComponent: RouteError,
  component: HealthLayout,
});

function HealthLayout() {
  return (
    <WorkspaceShell
      workspace="health"
      header={
        <PageHeader
          eyebrow="Body"
          title="Health"
          voice="One useful next action — then the rest of the day gets easier."
        />
      }
    >
      <Outlet />
    </WorkspaceShell>
  );
}
