import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { DatabaseZap, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { migrateFinanceToHousehold, type MigrationResult } from "@/server/migrate";

/**
 * One-time admin action (ADR-017): move Brian's existing finance data into the
 * shared household scope. Idempotent and Brian-only. Remove this route once run.
 */
export const Route = createFileRoute("/admin/migrate")({
  component: MigratePage,
});

function MigratePage() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MigrationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await migrateFinanceToHousehold());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Migration failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 py-12 sm:px-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <DatabaseZap className="size-4 text-primary" /> Migrate finance → household
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            Copies Brian&apos;s existing finance data (transactions, budget, subscriptions, category
            rules, and daily snapshots) into the shared household scope so both members see it. Safe
            to run more than once — it skips if the household already has finance data.
          </p>
          <Button onClick={run} disabled={busy} className="gap-2">
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <DatabaseZap className="size-4" />
            )}
            Run migration
          </Button>
          {result && (
            <div className="rounded-md border bg-muted/40 p-3 text-xs">
              {result.migrated
                ? `Migrated ${result.copied} finance object(s) to the household scope.`
                : `No changes — ${result.reason ?? "nothing to migrate"}.`}
            </div>
          )}
          {error && <div className="text-xs text-destructive">{error}</div>}
        </CardContent>
      </Card>
    </div>
  );
}
