import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Dumbbell,
  Target,
  Utensils,
  Wallet,
  Sparkles,
  RefreshCw,
  Save,
  Trophy,
  TriangleAlert,
  ArrowRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  loadDailyDashboard,
  loadProductivityTasksForDay,
  loadWorkoutSessions,
  loadWeeklyReview,
  saveProductivityTasksForDay,
  saveWeeklyReview,
} from "@/lib/server/domain";
import { generateWeeklyNarrative, type WeeklyNarrativeResult } from "@/lib/server/coach";
import {
  createProductivityTask,
  flOzToMl,
  mlToFlOz,
  todayISO,
  toISODate,
  toISOWeek,
  type ISODate,
} from "@/lib/domain";

export const Route = createFileRoute("/weekly")({
  component: Weekly,
});

function mondayOf(base: ISODate): Date {
  const d = new Date(base + "T00:00:00");
  const dayMon0 = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  d.setDate(d.getDate() - dayMon0);
  return d;
}

function weekDates(base: ISODate): ISODate[] {
  const monday = mondayOf(base);
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(monday);
    x.setDate(monday.getDate() + i);
    return toISODate(x);
  });
}

interface WeekStats {
  tasksCompleted: number;
  tasksTotal: number;
  workouts: number;
  avgProteinPct: number;
  avgWaterOz: number;
  netWorth: number;
  activeDays: number;
  perDayCompletion: { date: ISODate; pct: number; total: number }[];
}

function Weekly() {
  const [anchor, setAnchor] = useState<ISODate>(todayISO());
  const dates = weekDates(anchor);
  const week = toISOWeek(mondayOf(anchor));
  const weekLabel = `${dates[0]} → ${dates[6]}`;

  const [stats, setStats] = useState<WeekStats | null>(null);
  const [loading, setLoading] = useState(false);

  const [narrative, setNarrative] = useState<WeeklyNarrativeResult | null>(null);
  const [narrativeLoading, setNarrativeLoading] = useState(false);

  // Editable review fields
  const [wins, setWins] = useState("");
  const [blockers, setBlockers] = useState("");
  const [nextWeekFocus, setNextWeekFocus] = useState("");
  const [reflection, setReflection] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [scheduledAt, setScheduledAt] = useState<number | null>(null);

  const loadWeek = useCallback(async () => {
    setLoading(true);
    setNarrative(null);
    try {
      const [dashboards, sessions, review] = await Promise.all([
        Promise.all(dates.map((d) => loadDailyDashboard({ data: d }))),
        loadWorkoutSessions(),
        loadWeeklyReview({ data: week }),
      ]);

      let tasksCompleted = 0;
      let tasksTotal = 0;
      let proteinPctSum = 0;
      let proteinDays = 0;
      let waterSum = 0;
      let waterDays = 0;
      let netWorth = 0;
      let activeDays = 0;
      const perDayCompletion: WeekStats["perDayCompletion"] = [];

      dashboards.forEach((dash, i) => {
        const tasks = (dash.productivity?.tasks || []).filter((t) => !t.deletedAt);
        const done = tasks.filter((t) => t.done).length;
        tasksTotal += tasks.length;
        tasksCompleted += done;
        perDayCompletion.push({
          date: dates[i],
          pct: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
          total: tasks.length,
        });

        const protein = dash.nutrition?.totals?.protein ?? 0;
        const target = dash.plan?.nutritionTargets?.protein ?? 150;
        if (protein > 0) {
          proteinPctSum += Math.min(100, Math.round((protein / Math.max(1, target)) * 100));
          proteinDays++;
        }
        const water = dash.nutrition?.waterMl ?? 0;
        if (water > 0) {
          waterSum += water;
          waterDays++;
        }
        if (dash.finance?.netWorth) netWorth = dash.finance.netWorth;

        const active =
          tasks.length > 0 ||
          (dash.nutrition?.mealLogs?.length ?? 0) > 0 ||
          water > 0 ||
          (dash.recent?.transcripts?.length ?? 0) > 0;
        if (active) activeDays++;
      });

      const monday = mondayOf(anchor).getTime();
      const sundayEnd = new Date(dates[6] + "T23:59:59.999").getTime();
      const workouts = (sessions?.sessions || []).filter(
        (s) => !s.deletedAt && s.performedAt >= monday && s.performedAt <= sundayEnd,
      ).length;

      setStats({
        tasksCompleted,
        tasksTotal,
        workouts,
        avgProteinPct: proteinDays ? Math.round(proteinPctSum / proteinDays) : 0,
        avgWaterOz: mlToFlOz(waterDays ? Math.round(waterSum / waterDays) : 0) ?? 0,
        netWorth,
        activeDays,
        perDayCompletion,
      });

      // Hydrate any saved review
      setWins((review?.wins || []).join("\n"));
      setBlockers((review?.blockers || []).join("\n"));
      setNextWeekFocus((review?.nextWeekFocus || []).join("\n"));
      setReflection(review?.reflection || "");
    } catch (e) {
      console.warn("[weekly] load failed", e);
      setStats(null);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);

  useEffect(() => {
    loadWeek();
  }, [loadWeek]);

  async function generate() {
    if (!stats) return;
    setNarrativeLoading(true);
    try {
      const result = await generateWeeklyNarrative({
        data: {
          week,
          tasksCompleted: stats.tasksCompleted,
          tasksTotal: stats.tasksTotal,
          workouts: stats.workouts,
          avgProteinPct: stats.avgProteinPct,
          avgWaterMl: flOzToMl(stats.avgWaterOz) ?? 0,
          netWorth: stats.netWorth,
          activeDays: stats.activeDays,
        },
      });
      setNarrative(result);
      // Pre-fill editable fields if they're empty
      setWins((w) => (w.trim() ? w : result.wins.join("\n")));
      setBlockers((b) => (b.trim() ? b : result.blockers.join("\n")));
      setNextWeekFocus((n) => (n.trim() ? n : result.nextWeekFocus.join("\n")));
      setReflection((r) => (r.trim() ? r : result.reflection));
    } catch (e) {
      console.warn("[weekly] narrative failed", e);
    } finally {
      setNarrativeLoading(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const toLines = (s: string) =>
        s
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean);
      await saveWeeklyReview({
        data: {
          id: `review-${week}`,
          createdAt: Date.now(),
          week,
          wins: toLines(wins),
          blockers: toLines(blockers),
          nextWeekFocus: toLines(nextWeekFocus),
          reflection: reflection.trim() || undefined,
        },
      });
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 2500);
    } catch (e) {
      console.error("[weekly] save failed", e);
    } finally {
      setSaving(false);
    }
  }

  async function scheduleNextWeek() {
    const lines = nextWeekFocus
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 5);
    if (!lines.length) return;

    setSaving(true);
    try {
      const nextMonday = new Date(mondayOf(anchor));
      nextMonday.setDate(nextMonday.getDate() + 7);
      const targetDate = toISODate(nextMonday);
      const existing = await loadProductivityTasksForDay({ data: targetDate });
      const tasks = [
        ...(existing?.tasks || []),
        ...lines.map((line, index) =>
          createProductivityTask({
            text: `Next week: ${line}`,
            date: targetDate,
            tags: ["weekly-review", "coach-plan"],
            priority: index === 0 ? 1 : 2,
            source: "ai",
          }),
        ),
      ];
      await saveProductivityTasksForDay({ data: { date: targetDate, tasks } });
      setScheduledAt(Date.now());
      setTimeout(() => setScheduledAt(null), 2500);
    } catch (e) {
      console.error("[weekly] schedule next week failed", e);
    } finally {
      setSaving(false);
    }
  }

  function shiftWeek(delta: number) {
    const d = new Date(anchor + "T00:00:00");
    d.setDate(d.getDate() + delta * 7);
    setAnchor(toISODate(d));
  }

  const completion =
    stats && stats.tasksTotal > 0 ? Math.round((stats.tasksCompleted / stats.tasksTotal) * 100) : 0;

  return (
    <div className="min-h-dvh bg-background px-4 pb-16 pt-6 sm:px-6">
      <div className="mx-auto w-full max-w-page">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-[2px] text-muted-foreground">
              Weekly Review
            </div>
            <div className="flex items-center gap-2 text-3xl font-semibold tracking-tighter">
              <CalendarRange className="size-7 text-primary" /> {week}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{weekLabel}</div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => shiftWeek(-1)}
              aria-label="Previous week"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAnchor(todayISO())}>
              This week
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => shiftWeek(1)}
              aria-label="Next week"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>

        {/* Stat tiles */}
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            icon={Target}
            label="Task completion"
            value={`${completion}%`}
            sub={stats ? `${stats.tasksCompleted}/${stats.tasksTotal}` : "—"}
          />
          <StatTile
            icon={Dumbbell}
            label="Workouts"
            value={stats ? String(stats.workouts) : "—"}
            sub="sessions"
          />
          <StatTile
            icon={Utensils}
            label="Avg protein"
            value={stats ? `${stats.avgProteinPct}%` : "—"}
            sub="of target"
          />
          <StatTile
            icon={Wallet}
            label="Net worth"
            value={stats ? `$${stats.netWorth.toLocaleString()}` : "—"}
            sub={stats ? `${stats.activeDays}/7 active` : ""}
          />
        </div>

        {/* Per-day completion bars */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Daily task completion</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-sm text-muted-foreground">Loading week…</div>
            ) : (
              <div className="flex items-end justify-between gap-2 h-32">
                {stats?.perDayCompletion.map((d) => {
                  const dow = new Date(d.date + "T00:00:00").toLocaleDateString([], {
                    weekday: "short",
                  });
                  return (
                    <div key={d.date} className="flex flex-1 flex-col items-center gap-1">
                      <div className="flex w-full flex-1 items-end">
                        <div
                          className="w-full rounded-t bg-primary transition-all"
                          style={{ height: `${Math.max(4, d.pct)}%`, opacity: d.total ? 1 : 0.2 }}
                          title={`${d.pct}% (${d.total} tasks)`}
                        />
                      </div>
                      <div className="text-[10px] text-muted-foreground">{dow}</div>
                      <div className="text-[10px] tabular-nums text-muted-foreground/70">
                        {d.total ? `${d.pct}%` : "–"}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* AI review */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Sparkles className="size-4 text-primary" /> Coach’s Weekly Review
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs font-normal"
                onClick={generate}
                disabled={narrativeLoading || !stats}
              >
                <RefreshCw className={`size-3.5 ${narrativeLoading ? "animate-spin" : ""}`} />
                {narrativeLoading ? "Reflecting…" : "Generate"}
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {narrative?.reflection && (
              <p className="text-muted-foreground">{narrative.reflection}</p>
            )}

            <ReviewField
              icon={Trophy}
              label="Wins"
              value={wins}
              onChange={setWins}
              placeholder="One win per line…"
            />
            <ReviewField
              icon={TriangleAlert}
              label="Blockers"
              value={blockers}
              onChange={setBlockers}
              placeholder="What got in the way…"
            />
            <ReviewField
              icon={ArrowRight}
              label="Next week focus"
              value={nextWeekFocus}
              onChange={setNextWeekFocus}
              placeholder="Priorities for next week…"
            />

            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Reflection</div>
              <Textarea
                value={reflection}
                onChange={(e) => setReflection(e.target.value)}
                rows={3}
                placeholder="Freeform reflection…"
              />
            </div>

            <div className="flex items-center gap-3">
              <Button size="sm" className="gap-1.5" onClick={save} disabled={saving}>
                <Save className="size-4" /> {saving ? "Saving…" : "Save review"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={scheduleNextWeek}
                disabled={saving || !nextWeekFocus.trim()}
              >
                <ArrowRight className="size-4" /> Schedule next week
              </Button>
              {savedAt && <span className="text-xs text-muted-foreground">Saved ✓</span>}
              {scheduledAt && <span className="text-xs text-muted-foreground">Scheduled ✓</span>}
              {narrative && (
                <span className="text-[10px] text-muted-foreground/60">
                  {narrative.generatedBy === "ai" ? "AI-generated" : "Coach (offline rules)"}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Target;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground/70 tabular-nums">{sub}</div>}
    </div>
  );
}

function ReviewField({
  icon: Icon,
  label,
  value,
  onChange,
  placeholder,
}: {
  icon: typeof Target;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder={placeholder}
      />
    </div>
  );
}
