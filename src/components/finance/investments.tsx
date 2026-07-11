import { fmtMoney } from "@/components/finance/shared";
import type { FinanceTabProps } from "@/components/finance/shared";
import { useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { saveDailyFinance } from "@/server/domain";
import { refreshQuotes } from "@/server/finance";
import { type Position } from "@/lib/domain";
import { MiniStat } from "@/components/finance/shared";

export function InvestmentsTab({
  hub,
  today,
  onChange,
  flash,
}: FinanceTabProps & { today: string }) {
  const [symbol, setSymbol] = useState("");
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showAddPosition, setShowAddPosition] = useState(false);
  const [showAllPositions, setShowAllPositions] = useState(false);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [liveSymbols, setLiveSymbols] = useState<Set<string>>(new Set());

  const positions = hub.snapshot.positions || [];
  const total = positions.reduce((s, p) => s + (p.value || 0), 0);
  const sortedPositions = [...positions].sort((a, b) => (b.value || 0) - (a.value || 0));
  const visiblePositions = showAllPositions ? sortedPositions : sortedPositions.slice(0, 5);
  const topHolding = sortedPositions[0];
  const allocationPct = (p: Position) =>
    total > 0 ? Math.round(((p.value || 0) / total) * 100) : 0;

  async function refreshPrices() {
    if (!positions.length) return;
    setRefreshing(true);
    try {
      const { prices, asOf: ts } = await refreshQuotes({
        data: { symbols: positions.map((p) => p.symbol) },
      });
      // Resolved symbols get the live close; everything else (a 401K balance,
      // a typo, a delisted name) keeps its last manual price.
      const updated = positions.map((p) => {
        const live = prices[p.symbol.toUpperCase()];
        if (!Number.isFinite(live)) return p;
        return {
          ...p,
          price: live,
          value: Math.round(p.quantity * live * 100) / 100,
        };
      });
      const hits = Object.keys(prices).length;
      if (hits) {
        await saveDailyFinance({
          data: {
            date: today,
            finance: {
              date: today,
              accounts: hub.snapshot.accounts || [],
              positions: updated,
            },
          },
        });
        await onChange();
      }
      setLiveSymbols(new Set(Object.keys(prices)));
      setAsOf(ts);
      const missed = positions.length - hits;
      flash(
        hits
          ? `Updated ${hits} price${hits === 1 ? "" : "s"}.${missed ? ` ${missed} kept manual.` : ""}`
          : "No live prices found — kept manual prices.",
      );
    } finally {
      setRefreshing(false);
    }
  }

  async function addPosition(e: React.SyntheticEvent) {
    e.preventDefault();
    const q = Number(qty);
    const pr = Number(price);
    if (!symbol.trim() || !Number.isFinite(q) || !Number.isFinite(pr)) return;
    setBusy(true);
    try {
      const next: Position[] = [...positions];
      const idx = next.findIndex((p) => p.symbol.toLowerCase() === symbol.trim().toLowerCase());
      const pos: Position = {
        symbol: symbol.trim().toUpperCase(),
        quantity: q,
        price: pr,
        value: Math.round(q * pr * 100) / 100,
      };
      if (idx >= 0) next[idx] = pos;
      else next.push(pos);
      await saveDailyFinance({
        data: {
          date: today,
          finance: {
            date: today,
            accounts: hub.snapshot.accounts || [],
            positions: next,
          },
        },
      });
      setSymbol("");
      setQty("");
      setPrice("");
      await onChange();
      flash("Holding saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-card px-4 py-4 ring-1 ring-foreground/10">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Holdings total value
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums sm:text-3xl">
          {fmtMoney(total)}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <MiniStat label="Positions" value={String(positions.length)} />
          <MiniStat
            label="Top holding"
            value={topHolding ? `${topHolding.symbol} · ${allocationPct(topHolding)}%` : "—"}
          />
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-base">Holdings</CardTitle>
            {asOf && (
              <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                Prices as of {new Date(asOf).toLocaleTimeString()}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="shrink-0 gap-1 whitespace-nowrap transition-[scale,background-color,color,box-shadow] active:scale-[0.96]"
              onClick={() => setShowAddPosition((open) => !open)}
            >
              <Plus className="size-4" /> {showAddPosition ? "Hide form" : "Add position"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="shrink-0 gap-1 whitespace-nowrap transition-[scale,background-color,color,box-shadow] active:scale-[0.96]"
              disabled={refreshing || !positions.length}
              onClick={refreshPrices}
            >
              <RefreshCw className={`size-4${refreshing ? " animate-spin" : ""}`} />
              {refreshing ? "Refreshing…" : "Refresh prices"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {positions.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-120 text-sm">
                <thead>
                  <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="py-1.5 pr-2 text-left font-medium">Symbol</th>
                    <th className="px-2 py-1.5 text-right font-medium">Qty</th>
                    <th className="px-2 py-1.5 text-right font-medium">Price</th>
                    <th className="px-2 py-1.5 text-right font-medium">Value</th>
                    <th className="w-48 py-1.5 pl-2 text-right font-medium">Allocation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {visiblePositions.map((p) => {
                    const pct = allocationPct(p);
                    const isLive = liveSymbols.has(p.symbol.toUpperCase());
                    return (
                      <tr key={p.symbol}>
                        <td className="py-2 pr-2">
                          <span className="flex items-center gap-1.5 font-medium">
                            {p.symbol}
                            {isLive && (
                              <Badge
                                variant="secondary"
                                className="gap-1 bg-emerald-500/10 text-[10px] uppercase tracking-wide text-emerald-600 dark:text-emerald-400"
                              >
                                <span className="size-1.5 rounded-full bg-emerald-500" />
                                Live
                              </Badge>
                            )}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                          {p.quantity.toLocaleString(undefined, {
                            maximumFractionDigits: 4,
                          })}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                          {fmtMoney(p.price)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {fmtMoney(p.value || 0)}
                        </td>
                        <td className="py-2 pl-2">
                          <div className="relative ml-auto h-8 w-full min-w-36 overflow-hidden rounded-lg bg-muted/60">
                            <span
                              className="absolute inset-y-0 left-0 rounded-lg bg-primary/25 transition-[width] duration-300 ease-out"
                              style={{ width: `${pct}%` }}
                              aria-hidden
                            />
                            <span className="relative flex h-full items-center justify-end px-2 text-xs font-medium tabular-nums text-foreground">
                              {pct}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {sortedPositions.length > 5 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  onClick={() => setShowAllPositions((show) => !show)}
                >
                  {showAllPositions ? "Show top 5" : `Show all ${sortedPositions.length}`}
                </Button>
              )}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              No holdings yet. Brokerage positions (Robinhood) arrive automatically with each
              SimpleFIN sync; add anything else manually (e.g. your ADP 401k balance as symbol
              “401K”).
            </div>
          )}
          {showAddPosition && (
            <form onSubmit={addPosition} className="mt-4 flex flex-wrap items-center gap-2">
              <Input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="Symbol"
                className="w-28"
                disabled={busy}
              />
              <Input
                type="number"
                step="any"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                placeholder="Qty"
                className="w-24"
                disabled={busy}
              />
              <Input
                type="number"
                step="any"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="Price"
                className="w-28"
                disabled={busy}
              />
              <Button type="submit" size="sm" className="gap-1" disabled={busy || !symbol.trim()}>
                <Plus className="size-4" /> Save
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Educational guidance only. This app never moves money or executes trades.
      </p>
    </div>
  );
}

/* ---------------- Grow (AI advisor) ---------------- */
