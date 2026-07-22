import { fmtMoney } from "@/components/finance/shared";
import { Collapse } from "@/components/motion";
import { useEffect, useState } from "react";
import {
  ArrowsClockwiseIcon,
  CaretDownIcon,
  CheckCircleIcon,
  LinkIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  backfillSimplefinHistory,
  undoSimplefinHistory,
  connectSimplefin,
  disconnectSimplefin,
  saveSimplefinMappings,
  syncSimplefinNow,
  type SimplefinStatusPayload,
} from "@/server/finance";
import { CollapsibleCard, fmtDate } from "@/components/finance/shared";

type SyncState =
  | { phase: "idle" }
  | { phase: "syncing" }
  | { phase: "success"; message: string; transactionCount: number; at: number }
  | { phase: "warning"; message: string; transactionCount: number; at: number }
  | { phase: "error"; message: string };

function fmtDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function SimplefinConnectionsCard({
  status,
  loading,
  onChange,
  flash,
  defaultOpen = true,
}: {
  status?: SimplefinStatusPayload;
  loading: boolean;
  onChange: () => Promise<void>;
  flash: (msg: string) => void;
  /** Overview collapses this by default; other callers can keep it open. */
  defaultOpen?: boolean;
}) {
  const [setupToken, setSetupToken] = useState("");
  const [aliasDrafts, setAliasDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // Dedicated sync lifecycle so the button can narrate itself instead of just
  // looking disabled. The success/error result stays visible after onChange()
  // refreshes `status`, so it survives the query refresh long enough to read.
  const [syncState, setSyncState] = useState<SyncState>({ phase: "idle" });
  // Management rows (aliases, loan links, history imports, disconnect) live
  // behind a disclosure — the summary row + Sync now cover the daily need.
  const [expanded, setExpanded] = useState(false);
  const connected = !!status?.connected;
  const nextSyncAt = status?.manualSyncAvailableAt;
  const manualSyncBlocked = !!nextSyncAt && nextSyncAt > Date.now();

  // Disconnect/reconnect (or any authoritative loss of the connection) must not
  // leave stale success/error narration from the previous connection on screen.
  useEffect(() => {
    if (!connected) setSyncState({ phase: "idle" });
  }, [connected]);

  async function connect(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!setupToken.trim()) return;
    setBusy(true);
    try {
      await connectSimplefin({ data: { setupToken } });
      setSetupToken("");
      await onChange();
      flash("SimpleFIN connected.");
    } catch (err: any) {
      console.error(err);
      flash(err?.message || "Couldn’t connect SimpleFIN.");
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    if (syncState.phase === "syncing") return;
    setBusy(true);
    setSyncState({ phase: "syncing" });
    try {
      const result = await syncSimplefinNow({ data: {} });
      // Record the authoritative sync outcome BEFORE refreshing derived views,
      // so a later refresh failure can't downgrade a real success to an error.
      const persisted = result.status.lastSync;
      const at = persisted?.at ?? Date.now();
      if (result.ok) {
        setSyncState({
          phase: "success",
          message: result.message,
          transactionCount: result.transactionCount,
          at,
        });
      } else if (
        // ok:false with data persisted: the freshly written lastSync carries
        // this run's message plus an ingested transactionCount, because Bridge
        // warnings don't discard the accounts we did fetch. Hard failures
        // (auth, fetch, rate limit) never reach ingestion, so transactionCount
        // stays absent and the persisted message won't match this run.
        persisted?.message === result.message &&
        typeof persisted?.transactionCount === "number"
      ) {
        setSyncState({
          phase: "warning",
          message: result.message,
          transactionCount: result.transactionCount,
          at,
        });
      } else {
        setSyncState({ phase: "error", message: result.message });
      }
      // Refresh status/derived views. A refresh failure must not clobber the
      // sync outcome we just recorded, so swallow it independently.
      try {
        await onChange();
      } catch (refreshErr) {
        console.error(refreshErr);
      }
    } catch (err: any) {
      console.error(err);
      setSyncState({
        phase: "error",
        message: err?.message || "Couldn’t sync SimpleFIN.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await disconnectSimplefin({ data: {} });
      await onChange();
      flash("SimpleFIN disconnected.");
    } catch (err: any) {
      console.error(err);
      flash(err?.message || "Couldn’t disconnect SimpleFIN.");
    } finally {
      setBusy(false);
    }
  }

  async function saveAlias(accountId: string, fallback: string) {
    const alias = (aliasDrafts[accountId] ?? fallback).trim();
    setBusy(true);
    try {
      await saveSimplefinMappings({
        data: { aliases: { [accountId]: alias } },
      });
      await onChange();
      flash("Account alias saved.");
    } catch (err: any) {
      console.error(err);
      flash(err?.message || "Couldn’t save alias.");
    } finally {
      setBusy(false);
    }
  }

  async function backfillHistory(accountId: string) {
    setBusy(true);
    try {
      const result = await backfillSimplefinHistory({ data: { accountId } });
      await onChange();
      flash(result.message);
    } catch (err: any) {
      console.error(err);
      flash(err?.message || "Couldn’t import account history.");
    } finally {
      setBusy(false);
    }
  }

  async function undoHistory(accountId: string) {
    setBusy(true);
    try {
      const result = await undoSimplefinHistory({ data: { accountId } });
      await onChange();
      flash(result.message);
    } catch (err: any) {
      console.error(err);
      flash(err?.message || "Couldn’t undo the history import.");
    } finally {
      setBusy(false);
    }
  }

  async function linkLoan(accountId: string, subscriptionId: string) {
    setBusy(true);
    try {
      await saveSimplefinMappings({
        data: { loanLinks: { [accountId]: subscriptionId || null } },
      });
      await onChange();
      flash(subscriptionId ? "Loan link saved." : "Loan link removed.");
    } catch (err: any) {
      console.error(err);
      flash(err?.message || "Couldn’t save loan link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CollapsibleCard
      id="simplefin-connections"
      title="Bank connections"
      icon={LinkIcon}
      defaultOpen={defaultOpen}
      summary={
        connected
          ? status?.lastSync
            ? `Last sync ${fmtDate(status.lastSync.at)}`
            : "Connected"
          : loading
            ? "Checking sync status"
            : "Not connected"
      }
      forceOpen={
        !!status?.missingSealKey ||
        (status?.lastSync?.ok === false && typeof status?.lastSync?.transactionCount !== "number")
      }
    >
      <div className="space-y-3">
        {status?.missingSealKey && (
          <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
            SIMPLEFIN_SEAL_KEY is missing. Add a 32-byte base64 Workers secret before connecting.
          </div>
        )}

        {status?.lastSync?.ok === false && typeof status.lastSync.transactionCount !== "number" && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
            {status.lastSync.message || "The last sync failed. Check your connection."}
            {manualSyncBlocked && nextSyncAt ? (
              <span className="mt-1 block text-muted-foreground/80">
                Try again after {fmtDateTime(nextSyncAt)}.
              </span>
            ) : (
              <button
                type="button"
                onClick={syncNow}
                disabled={busy || loading}
                className="mt-1 block font-medium underline underline-offset-2 hover:text-destructive/80 disabled:opacity-50"
              >
                Retry sync
              </button>
            )}
          </div>
        )}

        {!connected ? (
          <form onSubmit={connect} className="space-y-2">
            <Label htmlFor="simplefin-token">SimpleFIN setup token</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="simplefin-token"
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                placeholder="Paste setup token"
                className="flex-1"
              />
              <Button type="submit" disabled={busy || loading || !setupToken.trim()}>
                Connect
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              The access URL is sealed on the server and never sent back to this page.
            </p>
          </form>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <span className="size-1.5 rounded-full bg-success" />
                Connected
              </span>
              {status?.accounts.length ? (
                <span className="text-xs text-muted-foreground">
                  {status.accounts.length} account
                  {status.accounts.length === 1 ? "" : "s"}
                </span>
              ) : null}
              <span className="min-w-2 flex-1" />
              <Button
                type="button"
                size="sm"
                className="gap-1"
                onClick={syncNow}
                disabled={busy || loading || manualSyncBlocked || syncState.phase === "syncing"}
                aria-label={syncState.phase === "syncing" ? "Syncing accounts" : "Sync now"}
                title={
                  manualSyncBlocked && nextSyncAt
                    ? `Available ${fmtDateTime(nextSyncAt)}`
                    : "Sync balances and transactions"
                }
              >
                <ArrowsClockwiseIcon
                  className={`size-4${syncState.phase === "syncing" ? " animate-spin" : ""}`}
                  weight="duotone"
                />
                {syncState.phase === "syncing" ? "Syncing…" : "Sync now"}
              </Button>
            </div>

            {/* Live sync narration. aria-live=polite announces phase changes to
                screen readers; the region stays mounted so success/error text
                persists after the query refresh instead of vanishing. */}
            <div aria-live="polite" className="min-h-0">
              {syncState.phase === "syncing" && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ArrowsClockwiseIcon className="size-3.5 animate-spin" weight="duotone" />
                  Syncing accounts…
                </p>
              )}
              {syncState.phase === "success" && (
                <p className="flex items-center gap-1.5 text-xs text-foreground">
                  <CheckCircleIcon className="size-3.5 shrink-0 text-success" weight="fill" />
                  <span>
                    {syncState.transactionCount > 0
                      ? `Sync complete — ${syncState.transactionCount} new transaction${
                          syncState.transactionCount === 1 ? "" : "s"
                        }.`
                      : "Sync complete — no new transactions."}{" "}
                    <span className="text-muted-foreground">
                      Last synced {fmtDateTime(syncState.at)}.
                    </span>
                  </span>
                </p>
              )}
              {syncState.phase === "warning" && (
                <p className="flex items-center gap-1.5 text-xs text-foreground">
                  <WarningCircleIcon className="size-3.5 shrink-0 text-warning" weight="fill" />
                  <span>
                    {syncState.message}{" "}
                    <span className="text-muted-foreground">
                      {syncState.transactionCount === 0
                        ? "No transactions imported."
                        : `${syncState.transactionCount} transaction${
                            syncState.transactionCount === 1 ? "" : "s"
                          } imported.`}{" "}
                      Last synced {fmtDateTime(syncState.at)}.
                    </span>
                  </span>
                </p>
              )}
              {syncState.phase === "error" && (
                <p className="flex items-center gap-1.5 text-xs text-destructive">
                  <WarningCircleIcon className="size-3.5 shrink-0" weight="fill" />
                  <span>
                    {syncState.message}{" "}
                    {manualSyncBlocked && nextSyncAt ? (
                      // Retry would just bounce off the manual rate limit, so
                      // explain when it becomes usable instead of offering a
                      // dead control. The aria-live region announces this.
                      <span className="text-muted-foreground">
                        Try again after {fmtDateTime(nextSyncAt)}.
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={syncNow}
                        disabled={busy || loading}
                        className="font-medium underline underline-offset-2 hover:text-destructive/80 disabled:opacity-50"
                      >
                        Retry
                      </button>
                    )}
                  </span>
                </p>
              )}
              {syncState.phase === "idle" &&
                status?.lastSync &&
                (status.lastSync.ok ? (
                  <p className="flex items-center gap-1.5 text-xs text-foreground">
                    <CheckCircleIcon className="size-3.5 shrink-0 text-success" weight="fill" />
                    <span>
                      {status.lastSync.message ?? "Last sync completed."}{" "}
                      <span className="text-muted-foreground">
                        Last synced {fmtDateTime(status.lastSync.at)}.
                      </span>
                    </span>
                  </p>
                ) : typeof status.lastSync.transactionCount === "number" ? (
                  // Partial warning: the run ingested accounts before a Bridge
                  // warning, so surface the imported count (including zero) plus
                  // the timestamp rather than framing it as a hard failure.
                  <p className="flex items-center gap-1.5 text-xs text-foreground">
                    <WarningCircleIcon className="size-3.5 shrink-0 text-warning" weight="fill" />
                    <span>
                      {status.lastSync.message ?? "Last sync had issues."}{" "}
                      <span className="text-muted-foreground">
                        {status.lastSync.transactionCount === 0
                          ? "No transactions imported."
                          : `${status.lastSync.transactionCount} transaction${
                              status.lastSync.transactionCount === 1 ? "" : "s"
                            } imported.`}{" "}
                        Last synced {fmtDateTime(status.lastSync.at)}.
                      </span>
                    </span>
                  </p>
                ) : (
                  // Hard failure (auth, fetch, rate limit): nothing ingested, so
                  // render destructive and give a real next step — the rate-limit
                  // time when a retry would bounce, otherwise a Retry control.
                  <p className="flex items-center gap-1.5 text-xs text-destructive">
                    <WarningCircleIcon className="size-3.5 shrink-0" weight="fill" />
                    <span>
                      {status.lastSync.message ?? "Last sync failed."}{" "}
                      {manualSyncBlocked && nextSyncAt ? (
                        <span className="text-muted-foreground">
                          Try again after {fmtDateTime(nextSyncAt)}.
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={syncNow}
                          disabled={busy || loading}
                          className="font-medium underline underline-offset-2 hover:text-destructive/80 disabled:opacity-50"
                        >
                          Retry
                        </button>
                      )}
                    </span>
                  </p>
                ))}
            </div>

            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex w-full items-center justify-between rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
              aria-expanded={expanded}
            >
              <span>Manage accounts &amp; connection</span>
              <CaretDownIcon
                className={`size-4 transition-transform ${expanded ? "" : "-rotate-90"}`}
                weight="duotone"
              />
            </button>

            <Collapse open={expanded} className="space-y-3">
              {status?.accounts.length ? (
                <ul className="space-y-2">
                  {status.accounts.map((account) => {
                    const stale =
                      account.balanceDate && Date.now() / 1000 - account.balanceDate > 48 * 60 * 60;
                    const aliasValue =
                      aliasDrafts[account.id] ?? status.aliases[account.id] ?? account.displayName;
                    return (
                      <li key={account.id} className="rounded-md border border-border/60 px-3 py-2">
                        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">
                              {account.orgName ? `${account.orgName} · ` : ""}
                              {account.name}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {fmtMoney(account.balance)} {account.currency}
                              {account.balanceDate
                                ? ` · as of ${fmtDate(account.balanceDate * 1000)}`
                                : ""}
                              {stale ? " · stale" : ""}
                            </div>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] lg:w-[24rem]">
                            <Input
                              value={aliasValue}
                              onChange={(e) =>
                                setAliasDrafts((drafts) => ({
                                  ...drafts,
                                  [account.id]: e.target.value,
                                }))
                              }
                              aria-label={`Alias for ${account.name}`}
                              className="h-8"
                            />
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => saveAlias(account.id, account.displayName)}
                              disabled={busy}
                            >
                              Save alias
                            </Button>
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {status.accountCutovers[account.id] ? (
                            <>
                              <span className="text-[11px] text-muted-foreground">
                                History imported since {status.accountCutovers[account.id]}
                              </span>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-[11px]"
                                onClick={() => undoHistory(account.id)}
                                disabled={busy}
                              >
                                Undo
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => backfillHistory(account.id)}
                                disabled={busy}
                              >
                                Import 90-day history
                              </Button>
                              <span className="text-[11px] text-muted-foreground">
                                Feeds recurring-charge detection. Skip if you already CSV-imported
                                this account — it could double-count.
                              </span>
                            </>
                          )}
                        </div>
                        {status.loanOptions.length > 0 && (
                          <div className="mt-2 flex flex-col gap-1 sm:flex-row sm:items-center">
                            <Label className="text-xs text-muted-foreground">Loan link</Label>
                            <Select
                              value={status.loanLinks[account.id] || "none"}
                              onValueChange={(v) => linkLoan(account.id, v === "none" ? "" : v)}
                              disabled={busy}
                            >
                              <SelectTrigger
                                aria-label="Loan link"
                                className="h-8 w-full sm:w-auto"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  <SelectItem value="none">Not linked</SelectItem>
                                  {status.loanOptions.map((loan) => (
                                    <SelectItem key={loan.id} value={loan.id}>
                                      {loan.name}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Connected. Run a sync to list accounts and write today’s finance snapshot.
                </p>
              )}

              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={disconnect}
                disabled={busy}
              >
                Disconnect
              </Button>
            </Collapse>
          </>
        )}
      </div>
    </CollapsibleCard>
  );
}
