import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import {
  BarChart3,
  Target,
  Utensils,
  Droplet,
  Wallet,
  Dumbbell,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { loadDailyDashboard, loadTransactions, loadWorkoutSessions } from "@/server/domain";
import { mlToFlOz, todayISO, toISODate, type ISODate } from "@/lib/domain";

export const Route = createFileRoute("/analytics")({
  component: Analytics,
});

interface DayPoint {
  date: ISODate;
  completionPct: number;
  tasksTotal: number;
  proteinPct: number;
  waterOz: number;
  netWorth: number;
  workouts: number;
  cashflow: number;
}

function lastNDates(n: number): ISODate[] {
  const out: ISODate[] = [];
  const today = new Date(todayISO() + "T00:00:00");
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    out.push(toISODate(d));
  }
  return out;
}

function Analytics() {
  const [range, setRange] = useState<7 | 14 | 30>(14);
  const [points, setPoints] = useState<DayPoint[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const dates = lastNDates(range);
      const [dashboards, sessions, txnStore] = await Promise.all([
        Promise.all(dates.map((d) => loadDailyDashboard({ data: d }))),
        loadWorkoutSessions(),
        loadTransactions(),
      ]);
      const allSessions = (sessions?.sessions || []).filter((s) => !s.deletedAt);
      const allTransactions = (txnStore?.transactions || []).filter((t) => !t.deletedAt);

      const pts: DayPoint[] = dashboards.map((dash, i) => {
        const date = dates[i];
        const tasks = (dash.productivity?.tasks || []).filter((t) => !t.deletedAt);
        const done = tasks.filter((t) => t.done).length;
        const protein = dash.nutrition?.totals?.protein ?? 0;
        const target = dash.plan?.nutritionTargets?.protein ?? 150;
        const dayStart = new Date(date + "T00:00:00").getTime();
        const dayEnd = new Date(date + "T23:59:59.999").getTime();
        return {
          date,
          completionPct: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
          tasksTotal: tasks.length,
          proteinPct:
            protein > 0 ? Math.min(100, Math.round((protein / Math.max(1, target)) * 100)) : 0,
          waterOz: mlToFlOz(dash.nutrition?.waterMl ?? 0) ?? 0,
          netWorth: dash.finance?.netWorth ?? 0,
          workouts: allSessions.filter((s) => s.performedAt >= dayStart && s.performedAt <= dayEnd)
            .length,
          cashflow: allTransactions
            .filter((t) => t.timestamp >= dayStart && t.timestamp <= dayEnd)
            .reduce((sum, t) => sum + t.amount, 0),
        };
      });
      setPoints(pts);
    } catch (e) {
      console.warn("[analytics] load failed", e);
      setPoints([]);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    load();
  }, [load]);

  const avg = (sel: (p: DayPoint) => number, onlyNonZero = false) => {
    const vals = points.map(sel).filter((v) => (onlyNonZero ? v > 0 : true));
    if (!vals.length) return 0;
    return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
  };
  const totalWorkouts = points.reduce((s, p) => s + p.workouts, 0);
  const latestNetWorth = [...points].reverse().find((p) => p.netWorth > 0)?.netWorth ?? 0;
  const firstNetWorth = points.find((p) => p.netWorth > 0)?.netWorth ?? 0;
  const netWorthTrend = latestNetWorth - firstNetWorth;
  const netCashflow = points.reduce((sum, p) => sum + p.cashflow, 0);

  return (
    <div className="min-h-dvh bg-background px-4 pb-16 pt-8 sm:px-6">
      <div className="mx-auto w-full max-w-page">
        <div className="mb-6 flex items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-[2px] text-muted-foreground">Analytics</div>
            <div className="flex items-center gap-2 text-3xl font-semibold tracking-tighter">
              <BarChart3 className="size-7 text-primary" /> Trends
            </div>
          </div>
          <div className="flex items-center gap-1">
            {([7, 14, 30] as const).map((r) => (
              <Button
                key={r}
                variant={range === r ? "default" : "outline"}
                size="sm"
                onClick={() => setRange(r)}
              >
                {r}d
              </Button>
            ))}
          </div>
        </div>

        {/* Summary tiles */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryTile
            icon={Target}
            label="Avg task completion"
            value={`${avg((p) => p.completionPct)}%`}
          />
          <SummaryTile
            icon={Dumbbell}
            label="Workouts"
            value={String(totalWorkouts)}
            sub={`in ${range} days`}
          />
          <SummaryTile
            icon={Utensils}
            label="Avg protein"
            value={`${avg((p) => p.proteinPct, true)}%`}
            sub="of target"
          />
          <SummaryTile
            icon={Wallet}
            label="Net worth"
            value={`$${latestNetWorth.toLocaleString()}`}
            trend={netWorthTrend}
          />
          <SummaryTile
            icon={Wallet}
            label="Net cashflow"
            value={`$${netCashflow.toLocaleString()}`}
            sub={`in ${range} days`}
          />
        </div>

        {loading ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              Crunching {range} days…
            </CardContent>
          </Card>
        ) : points.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No data yet. Log a few days from the dashboard.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            <ChartCard icon={Target} title="Task completion %" color="var(--primary)">
              <LineChart points={points} sel={(p) => p.completionPct} max={100} unit="%" />
            </ChartCard>
            <ChartCard icon={Utensils} title="Protein % of target" color="var(--primary)">
              <LineChart points={points} sel={(p) => p.proteinPct} max={100} unit="%" />
            </ChartCard>
            <ChartCard icon={Droplet} title="Water (fl oz)">
              <BarsChart points={points} sel={(p) => p.waterOz} unit=" fl oz" />
            </ChartCard>
            {latestNetWorth > 0 && (
              <ChartCard icon={Wallet} title="Net worth ($)">
                <LineChart
                  points={points.filter((p) => p.netWorth > 0)}
                  sel={(p) => p.netWorth}
                  unit="$"
                  prefix
                />
              </ChartCard>
            )}
            <ChartCard icon={Wallet} title="Daily cashflow ($)">
              <BarsChart points={points} sel={(p) => p.cashflow} unit="$" />
            </ChartCard>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryTile({
  icon: Icon,
  label,
  value,
  sub,
  trend,
}: {
  icon: typeof Target;
  label: string;
  value: string;
  sub?: string;
  trend?: number;
}) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-xl font-semibold tabular-nums">
        {value}
        {trend !== undefined && trend !== 0 && (
          <span
            className={`flex items-center text-xs ${trend > 0 ? "text-emerald-600" : "text-red-600"}`}
          >
            {trend > 0 ? (
              <TrendingUp className="size-3.5" />
            ) : (
              <TrendingDown className="size-3.5" />
            )}
            {Math.abs(trend).toLocaleString()}
          </span>
        )}
        {trend === 0 && <Minus className="size-3.5 text-muted-foreground" />}
      </div>
      {sub && <div className="text-[10px] text-muted-foreground/70">{sub}</div>}
    </div>
  );
}

function ChartCard({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Target;
  title: string;
  color?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
          <Icon className="size-4 text-primary" /> {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const W = 760;
const H = 120;
const PAD = 6;

function LineChart({
  points,
  sel,
  max,
  unit = "",
  prefix = false,
}: {
  points: DayPoint[];
  sel: (p: DayPoint) => number;
  max?: number;
  unit?: string;
  prefix?: boolean;
}) {
  if (points.length === 0) return null;
  const vals = points.map(sel);
  const top = max ?? Math.max(1, ...vals);
  const bottom = max ? 0 : Math.min(...vals);
  const span = Math.max(1, top - bottom);
  const stepX = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;
  const y = (v: number) => PAD + (1 - (v - bottom) / span) * (H - PAD * 2);
  const coords = vals.map((v, i) => [PAD + i * stepX, y(v)] as const);
  const line = coords
    .map(([x, yy], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${yy.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${coords[coords.length - 1][0].toFixed(1)},${H - PAD} L${PAD},${H - PAD} Z`;
  const latest = vals[vals.length - 1];
  const fmt = (v: number) => (prefix ? `$${v.toLocaleString()}` : `${v}${unit}`);

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        preserveAspectRatio="none"
        style={{ height: H }}
      >
        <path d={area} className="fill-primary/10" />
        <path d={line} className="stroke-primary" strokeWidth={2} fill="none" />
        {coords.map(([x, yy], i) => (
          <circle key={i} cx={x} cy={yy} r={2} className="fill-primary" />
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{points[0].date.slice(5)}</span>
        <span className="font-medium text-foreground">latest {fmt(latest)}</span>
        <span>{points[points.length - 1].date.slice(5)}</span>
      </div>
    </div>
  );
}

function BarsChart({
  points,
  sel,
  unit = "",
}: {
  points: DayPoint[];
  sel: (p: DayPoint) => number;
  unit?: string;
}) {
  const vals = points.map(sel);
  const top = Math.max(1, ...vals.map((v) => Math.abs(v)));
  return (
    <div>
      <div className="flex items-end justify-between gap-0.5" style={{ height: H }}>
        {points.map((p, i) => (
          <div
            key={p.date}
            className={`flex-1 rounded-t transition-all ${vals[i] < 0 ? "bg-red-500" : "bg-primary"}`}
            style={{
              height: `${Math.max(2, (Math.abs(vals[i]) / top) * 100)}%`,
              opacity: vals[i] ? 1 : 0.15,
            }}
            title={`${p.date}: ${vals[i]}${unit}`}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{points[0].date.slice(5)}</span>
        <span>{points[points.length - 1].date.slice(5)}</span>
      </div>
    </div>
  );
}
