import type { ReactNode } from "react";
import { PageShell } from "@/components/page-shell";
import { WorkspaceNav } from "@/components/workspace-nav";
import type { Workspace } from "@/lib/navigation";

// Per-workspace atmosphere treatment. Route layouts own this so child pages
// don't remount the ambient background or the local nav on every navigation.
const ATMOSPHERE: Record<
  Workspace,
  { atmosphere: "vital" | "focus"; density: "medium" | "dense" }
> = {
  health: { atmosphere: "vital", density: "medium" },
  money: { atmosphere: "focus", density: "dense" },
  review: { atmosphere: "focus", density: "dense" },
};

// Owns a workspace's ambient background, centered column, and local nav. The
// nav renders once here; optional layout-level header sits above the tabs;
// children supply only their page content.
export function WorkspaceShell({
  workspace,
  header,
  children,
}: {
  workspace: Workspace;
  /** Layout-level header (e.g. Finance Hub) — always above WorkspaceNav. */
  header?: ReactNode;
  children: ReactNode;
}) {
  const { atmosphere, density } = ATMOSPHERE[workspace];
  return (
    <PageShell atmosphere={atmosphere} density={density}>
      {header}
      <WorkspaceNav workspace={workspace} />
      {children}
    </PageShell>
  );
}
