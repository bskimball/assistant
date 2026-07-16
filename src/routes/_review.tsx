import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";
import { RouteError } from "@/components/route-error";
import { WorkspaceShell } from "@/components/workspace-shell";

// Pathless Review workspace layout. Owns atmosphere + static local nav once for
// /weekly and /analytics without adding a URL segment (ADR-025).
export const Route = createFileRoute("/_review")({
  errorComponent: RouteError,
  component: ReviewLayout,
});

function ReviewLayout() {
  return (
    <WorkspaceShell
      workspace="review"
      header={
        <PageHeader
          eyebrow="Reflection"
          title="Review"
          voice="Look back honestly. Plan the next week lightly."
        />
      }
    >
      <Outlet />
    </WorkspaceShell>
  );
}
