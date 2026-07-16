import { Link, useRouterState } from "@tanstack/react-router";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { WORKSPACES, type Workspace } from "@/lib/navigation";

export function WorkspaceNav({ workspace }: { workspace: Workspace }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const config = WORKSPACES[workspace];

  return (
    <nav aria-label={`${config.label} workspace`} className="mb-6 overflow-x-auto">
      <div className="relative flex min-w-max items-center gap-1 rounded-xl border border-border/50 bg-surface-raised/95 p-1 shadow-sm">
        {config.links.map((link) => {
          const active = pathname === link.to;

          return (
            <Link
              key={link.to}
              to={link.to}
              activeOptions={{ exact: true }}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative z-10 flex min-h-10 items-center rounded-lg px-3.5 py-2 text-sm font-medium outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring/60",
                active ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {active && (
                <motion.span
                  layoutId={`workspace-pill-${workspace}`}
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-lg bg-primary shadow-sm"
                  transition={{ type: "spring", duration: 0.35, bounce: 0 }}
                />
              )}
              <span className="relative z-10">{link.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
