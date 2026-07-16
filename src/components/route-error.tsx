import { Link } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { AlertTriangle, LayoutDashboard, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shared route error UI. Wire as `errorComponent` on layouts (and optionally
 * `defaultErrorComponent` on the root) so loader/render failures stay calm.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Something unexpected went wrong.";

  return (
    <div className="flex min-h-[50dvh] items-center justify-center px-4 py-12 sm:px-6">
      <div className="mx-auto w-full max-w-md text-center">
        <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl border border-destructive/20 bg-destructive/10">
          <AlertTriangle className="size-7 text-destructive" />
        </div>
        <div className="text-xs tracking-tight text-muted-foreground">Error</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tighter sm:text-3xl">
          That didn’t load.
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">{message}</p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" className="gap-1.5" onClick={reset}>
            <RefreshCw className="size-4" /> Try again
          </Button>
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link to="/">
              <LayoutDashboard className="size-4" /> Back to dashboard
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
