import { fmtMoney } from "@/components/finance/shared";
import { useState } from "react";
import { RefreshCw, ChevronDown, Link2 } from "lucide-react";
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

export function SimplefinConnectionsCard({
  status,
  loading,
  onChange,
  flash,
}: {
  status?: SimplefinStatusPayload;
  loading: boolean;
  onChange: () => Promise<void>;
  flash: (msg: string) => void;
}) {
  const [setupToken, setSetupToken] = useState("");
  const [aliasDrafts, setAliasDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // Management rows (aliases, loan links, history imports, disconnect) live
  // behind a disclosure — the summary row + Sync now cover the daily need.
  const [expanded, setExpanded] = useState(false);
  const connected = !!status?.connected;
  const nextSyncAt = status?.manualSyncAvailableAt;
  const manualSyncBlocked = !!nextSyncAt && nextSyncAt > Date.now();

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
    setBusy(true);
    try {
      const result = await syncSimplefinNow({ data: {} });
      await onChange();
      flash(result.message);
    } catch (err: any) {
      console.error(err);
      flash(err?.message || "Couldn’t sync SimpleFIN.");
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
      icon={Link2}
      summary={
        connected
          ? status?.lastSync
            ? `Last sync ${fmtDate(status.lastSync.at)}`
            : "Connected"
          : loading
            ? "Checking sync status"
            : "Not connected"
      }
      forceOpen={!!status?.missingSealKey || status?.lastSync?.ok === false}
    >
      <div className="space-y-3">
        {status?.missingSealKey && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            SIMPLEFIN_SEAL_KEY is missing. Add a 32-byte base64 Workers secret before connecting.
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
                <span className="size-1.5 rounded-full bg-emerald-500" />
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
                disabled={busy || loading || manualSyncBlocked}
                title={
                  manualSyncBlocked && nextSyncAt
                    ? `Available ${fmtDate(nextSyncAt)}`
                    : "Sync balances and transactions"
                }
              >
                <RefreshCw className="size-4" />
                Sync now
              </Button>
            </div>
            {status?.lastSync?.message && (
              <p className="text-xs text-muted-foreground">{status.lastSync.message}</p>
            )}

            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex w-full items-center justify-between rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
              aria-expanded={expanded}
            >
              <span>Manage accounts &amp; connection</span>
              <ChevronDown
                className={`size-4 transition-transform ${expanded ? "" : "-rotate-90"}`}
              />
            </button>

            {expanded && status?.accounts.length ? (
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
                            <SelectTrigger aria-label="Loan link" className="h-8 w-full sm:w-auto">
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
            ) : expanded ? (
              <p className="text-sm text-muted-foreground">
                Connected. Run a sync to list accounts and write today’s finance snapshot.
              </p>
            ) : null}

            {expanded && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={disconnect}
                disabled={busy}
              >
                Disconnect
              </Button>
            )}
          </>
        )}
      </div>
    </CollapsibleCard>
  );
}
