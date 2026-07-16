import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Target,
  Utensils,
  Droplet,
  Wallet,
  Dumbbell,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";
import { Item, Reveal, revealDelay, Stagger } from "@/components/motion";
import { todayISO } from "@/lib/domain";
import type { EffectivenessReport } from "@/lib/effectiveness-report";
import { analyticsRangeQuery, monthlyEffectivenessQuery } from "@/lib/queries";
import type { AnalyticsRange, DayPoint } from "@/lib/review-data";

export const Route = createFileRoute("/_review/analytics")({
  // Prime the default window so the first paint has data (SSR + revisit cache).
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.ensureQueryData(analyticsRangeQuery(14)),
      queryClient.ensureQueryData(monthlyEffectivenessQuery(todayISO().slice(0, 7))),
    ]),
  component: Analytics,
});

function recentMonths(currentMonth: string, count = 6): string[] {
  let year = Number(currentMonth.slice(0, 4));
  let month = Number(currentMonth.slice(5, 7));
  const months: string[] = [];

  for (let index = 0; index < count; index++) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month--;
    if (month === 0) {
      month = 12;
      year--;
    }
  }
  return months;
}

const EFFECTIVENESS_SOURCE_LABELS: Record<string, string> = {
  "health-next-action": "Health next action",
  "coach-weekly": "Weekly coach",
  coach: "Coach",
  finance: "Finance",
};

function effectivenessSourceLabel(source: string): string {
  return (
    EFFECTIVENESS_SOURCE_LABELS[source] ??
    source.replace(/-/g, " ").replace(/^./, (character) => character.toUpperCase())
  );
}

function Analytics() {
  const [range, setRange] = useState<AnalyticsRange>(14);
  const currentMonth = todayISO().slice(0, 7);
  const [effectivenessMonth, setEffectivenessMonth] = useState(currentMonth);
  // Primed by the loader; revisits hit the cache. `isPending` is only true on a
  // genuine cold load (no cached or placeholder data).
  const { data: points = [], isPending: loading } = useQuery(analyticsRangeQuery(range));
  const { data: effectiveness, isPending: effectivenessLoading } = useQuery(
    monthlyEffectivenessQuery(effectivenessMonth),
  );

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
    <>
      <div className="mb-6 flex items-center">
        <div className="zen-input flex items-center gap-1 rounded-lg border p-1">
          {([7, 14, 30] as const).map((r) => {
            const active = range === r;
            return (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                aria-pressed={active}
                className={`h-9 min-w-11 rounded px-3 text-sm font-medium tabular-nums transition-[background-color,color,box-shadow,scale] duration-150 ease-out active:scale-[0.96] ${
                  active
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {r}d
              </button>
            );
          })}
        </div>
      </div>

      {/* Summary tiles — 5 metrics, so 5 across on wide screens (no orphan row) */}
      <Stagger className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
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
          value={`${netCashflow < 0 ? "-" : "+"}$${Math.abs(netCashflow).toLocaleString()}`}
          sub={`logged · ${range}d`}
          tone={netCashflow < 0 ? "neg" : netCashflow > 0 ? "pos" : undefined}
        />
      </Stagger>

      <EffectivenessCard
        month={effectivenessMonth}
        months={recentMonths(currentMonth)}
        report={effectiveness}
        loading={effectivenessLoading}
        onMonthChange={setEffectivenessMonth}
      />

      {loading ? (
        <div className="zen-card p-6">
          <div className="animate-pulse py-10 text-center text-sm text-muted-foreground">
            Crunching <span className="tabular-nums">{range}</span> days…
          </div>
        </div>
      ) : points.length === 0 ? (
        <div className="zen-card relative overflow-hidden p-6">
          <div className="relative py-10 text-center text-sm text-muted-foreground">
            No data yet. Log a few days from the dashboard.
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <Reveal delay={revealDelay(0)}>
            <ChartCard icon={Target} title="Task completion %">
              <LineChart points={points} sel={(p) => p.completionPct} max={100} unit="%" />
            </ChartCard>
          </Reveal>
          <Reveal delay={revealDelay(1)}>
            <ChartCard icon={Utensils} title="Protein % of target">
              <LineChart points={points} sel={(p) => p.proteinPct} max={100} unit="%" />
            </ChartCard>
          </Reveal>
          <Reveal delay={revealDelay(2)}>
            <ChartCard icon={Droplet} title="Water (fl oz)">
              <BarsChart points={points} sel={(p) => p.waterOz} unit=" fl oz" />
            </ChartCard>
          </Reveal>
          {latestNetWorth > 0 && (
            <Reveal delay={revealDelay(3)}>
              <ChartCard icon={Wallet} title="Net worth ($)">
                <LineChart
                  points={points.filter((p) => p.netWorth > 0)}
                  sel={(p) => p.netWorth}
                  unit="$"
                  prefix
                />
              </ChartCard>
            </Reveal>
          )}
          <Reveal delay={revealDelay(4)}>
            <ChartCard icon={Wallet} title="Daily cashflow ($)">
              <BarsChart points={points} sel={(p) => p.cashflow} unit="$" />
            </ChartCard>
          </Reveal>
        </div>
      )}
    </>
  );
}

function EffectivenessCard({
  month,
  months,
  report,
  loading,
  onMonthChange,
}: {
  month: string;
  months: string[];
  report?: EffectivenessReport;
  loading: boolean;
  onMonthChange: (month: string) => void;
}) {
  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(
    new Date(`${month}-01T12:00:00Z`),
  );

  return (
    <div className="zen-card mb-6 overflow-hidden p-6">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-info/10 text-info">
            <Target className="size-4" />
          </span>
          Effectiveness
        </div>
        <label className="sr-only" htmlFor="effectiveness-month">
          Effectiveness month
        </label>
        <select
          id="effectiveness-month"
          value={month}
          onChange={(event) => onMonthChange(event.target.value)}
          className="zen-input h-9 rounded-md border px-2 text-sm font-medium"
        >
          {months.map((option) => (
            <option key={option} value={option}>
              {new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(
                new Date(`${option}-01T12:00:00Z`),
              )}
            </option>
          ))}
        </select>
      </div>
      <div>
        {loading && !report ? (
          <div className="animate-pulse py-4 text-center text-sm text-muted-foreground">
            Loading effectiveness…
          </div>
        ) : !report || report.total === 0 ? (
          <div className="py-4 text-center text-sm text-muted-foreground">
            No recommendation outcomes yet this month.
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
              <EffectivenessMetric label="Total" value={report.total} />
              <EffectivenessMetric label="Accepted" value={report.accepted} />
              <EffectivenessMetric label="Completed" value={report.completed} />
              <EffectivenessMetric label="Dismissed" value={report.dismissed} />
              <EffectivenessMetric label="Snoozed" value={report.snoozed} />
              <EffectivenessMetric
                label="Helpful"
                value={`Yes ${report.helpfulYes} · No ${report.helpfulNo}`}
              />
              <EffectivenessMetric
                label="Completion rate"
                value={`${Math.round(report.completionRate * 100)}%`}
              />
            </div>
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                By source · {monthLabel}
              </div>
              <div className="space-y-2">
                {Object.entries(report.bySource).map(([source, breakdown]) => (
                  <div
                    key={source}
                    className="zen-surface-nested flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-xs"
                  >
                    <span className="font-medium text-foreground">
                      {effectivenessSourceLabel(source)}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {breakdown.total} total · {breakdown.completed} completed ·{" "}
                      {Math.round(breakdown.completionRate * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
            {report.topCompleted.length > 0 && (
              <div>
                <div className="mb-2 text-xs font-medium text-muted-foreground">Top completed</div>
                <ol className="space-y-1.5 text-sm">
                  {report.topCompleted.map((text, index) => (
                    <li key={`${index}-${text}`} className="flex gap-2">
                      <span className="tabular-nums text-muted-foreground">{index + 1}.</span>
                      <span>{text}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EffectivenessMetric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="zen-surface-nested p-2.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function SummaryTile({
  icon: Icon,
  label,
  value,
  sub,
  trend,
  tone,
}: {
  icon: typeof Target;
  label: string;
  value: string;
  sub?: string;
  trend?: number;
  tone?: "pos" | "neg";
}) {
  const valueTone = tone === "pos" ? "text-success" : tone === "neg" ? "text-destructive" : "";
  return (
    <Item className="zen-card p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-info/10 text-info">
          <Icon className="size-3" />
        </span>
        {label}
      </div>
      <div
        className={`mt-1.5 flex items-center gap-1.5 text-xl font-semibold tabular-nums ${valueTone}`}
      >
        {value}
        {trend !== undefined && trend !== 0 && (
          <span
            className={`flex items-center text-xs tabular-nums ${trend > 0 ? "text-success" : "text-destructive"}`}
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
    </Item>
  );
}

function ChartCard({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Target;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="zen-card overflow-hidden p-6">
      <div className="mb-4 flex items-center gap-2 text-sm font-medium">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-info/10 text-info">
          <Icon className="size-4" />
        </span>
        {title}
      </div>
      <div>{children}</div>
    </div>
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
  // useId emits colons, which break `url(#…)` fragment references in SVG.
  const gradientId = `line-fill-${useId().replace(/:/g, "")}`;
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
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--info)" stopOpacity={0.22} />
            <stop offset="100%" stopColor="var(--info)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} stroke="var(--info)" strokeWidth={2} fill="none" />
        {coords.map(([x, yy], i) => {
          const isLatest = i === coords.length - 1;
          return (
            <g key={i}>
              {isLatest && <circle cx={x} cy={yy} r={5} fill="var(--info)" fillOpacity={0.2} />}
              <circle cx={x} cy={yy} r={isLatest ? 2.5 : 2} fill="var(--info)" />
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground tabular-nums">
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
            className={`flex-1 rounded-t-sm transition-[height,opacity] duration-300 ease-out ${
              vals[i] < 0 ? "bg-destructive/80" : "bg-info/80"
            }`}
            style={{
              height: `${Math.max(2, (Math.abs(vals[i]) / top) * 100)}%`,
              opacity: vals[i] ? 1 : 0.2,
            }}
            title={`${p.date}: ${vals[i]}${unit}`}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{points[0].date.slice(5)}</span>
        <span>{points[points.length - 1].date.slice(5)}</span>
      </div>
    </div>
  );
}
