import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
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
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Reveal, revealDelay } from "@/components/motion";
import {
  loadProductivityTasksForDay,
  recordRecommendationOutcome,
  saveProductivityTasksForDay,
  saveWeeklyReview,
} from "@/server/domain";
import { generateWeeklyNarrative, type WeeklyNarrativeResult } from "@/server/coach";
import {
  createProductivityTask,
  flOzToMl,
  addDaysISO,
  formatISODate,
  mondayOfISO,
  todayISO,
  toISOWeek,
  weekDatesISO,
  type ISODate,
} from "@/lib/domain";
import { stableRecommendationId } from "@/lib/recommendation-id";
import { queryKeys, weeklyDataQuery } from "@/lib/queries";

export const Route = createFileRoute("/_review/weekly")({
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(weeklyDataQuery(todayISO())),
  component: Weekly,
});

function Weekly() {
  const [anchor, setAnchor] = useState<ISODate>(todayISO());
  const dateInputRef = useRef<HTMLInputElement>(null);
  const dates = weekDatesISO(anchor);
  const week = toISOWeek(mondayOfISO(anchor));
  const weekLabel = `${dates[0]} → ${dates[6]}`;
  const isCurrentWeek = week === toISOWeek(mondayOfISO(todayISO()));
  const fmtDay = (date: ISODate) => formatISODate(date, { month: "short", day: "numeric" });
  const rangeLabel = `${fmtDay(dates[0])} – ${fmtDay(dates[6])}`;

  const queryClient = useQueryClient();
  const { data, isPending: loading, isPlaceholderData } = useQuery(weeklyDataQuery(anchor));
  const stats = data?.stats ?? null;
  const today = todayISO();

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

  // Hydrate the editable review fields once per week — keyed on `week`, not on
  // `data` identity, so a background refetch doesn't clobber unsaved edits.
  const hydratedWeek = useRef<string | null>(null);
  useEffect(() => {
    if (!data || hydratedWeek.current === week) return;
    hydratedWeek.current = week;
    const review = data.review;
    setWins((review?.wins || []).join("\n"));
    setBlockers((review?.blockers || []).join("\n"));
    setNextWeekFocus((review?.nextWeekFocus || []).join("\n"));
    setReflection(review?.reflection || "");
  }, [data, week]);

  // Stepping to a different week drops the previous week's AI narrative.
  useEffect(() => {
    setNarrative(null);
  }, [week]);

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
          checkInDays: stats.checkInDays,
          avgEnergy: stats.avgEnergy,
          avgDayRating: stats.avgDayRating,
          checkInWins: stats.checkInWins,
          checkInFrictions: stats.checkInFrictions,
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
      // Refresh the cached week so a later visit reflects the saved review.
      queryClient.invalidateQueries({ queryKey: queryKeys.weeklyData(week) });
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
      const targetDate = addDaysISO(mondayOfISO(anchor), 7);
      const existing = await loadProductivityTasksForDay({ data: targetDate });
      const newTasks = lines.map((line, index) =>
        createProductivityTask({
          text: `Next week: ${line}`,
          date: targetDate,
          tags: ["weekly-review", "coach-plan"],
          priority: index === 0 ? 1 : 2,
          source: "ai",
        }),
      );
      const tasks = [...(existing?.tasks || []), ...newTasks];
      await saveProductivityTasksForDay({ data: { date: targetDate, tasks } });
      await Promise.all(
        lines.map((line, index) =>
          recordRecommendationOutcome({
            data: {
              id: stableRecommendationId(targetDate, "coach-weekly", line),
              date: targetDate,
              source: "coach-weekly",
              text: line,
              status: "accepted",
              taskId: newTasks[index]?.id,
            },
          }),
        ),
      );
      setScheduledAt(Date.now());
      setTimeout(() => setScheduledAt(null), 2500);
    } catch (e) {
      console.error("[weekly] schedule next week failed", e);
    } finally {
      setSaving(false);
    }
  }

  function shiftWeek(delta: number) {
    setAnchor(addDaysISO(anchor, delta * 7));
  }

  const completion =
    stats && stats.tasksTotal > 0 ? Math.round((stats.tasksCompleted / stats.tasksTotal) * 100) : 0;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-2 text-sm">
        {/* This-week indicator — highlights on the current week, jumps back otherwise */}
        <Button
          variant={isCurrentWeek ? "default" : "outline"}
          size="sm"
          onClick={() => setAnchor(todayISO())}
          disabled={isCurrentWeek}
          className="h-8 shrink-0 gap-1.5 transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96] disabled:opacity-100"
          aria-label={isCurrentWeek ? "Showing this week" : "Go to this week"}
        >
          <span
            className={`size-1.5 rounded-full bg-current transition-opacity ${isCurrentWeek ? "opacity-100" : "opacity-0"}`}
          />
          This week
        </Button>

        <div className="flex flex-1 items-center gap-1.5 sm:flex-none">
          <Button
            variant="outline"
            size="icon"
            className="size-8 shrink-0 transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]"
            onClick={() => shiftWeek(-1)}
            aria-label="Previous week"
          >
            <ChevronLeft className="size-4" />
          </Button>
          {/* Range label doubles as the week picker trigger */}
          <div className="relative flex-1 sm:flex-none">
            <Button
              variant="outline"
              size="sm"
              onClick={() => dateInputRef.current?.showPicker?.()}
              className="h-8 w-full justify-center gap-1.5 font-medium tabular-nums transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96] sm:w-auto sm:min-w-[140px]"
              aria-label="Pick a week"
            >
              <CalendarDays className="size-3.5 text-muted-foreground" />
              {rangeLabel}
            </Button>
            <input
              ref={dateInputRef}
              type="date"
              value={anchor}
              onChange={(e) => {
                const v = e.target.value as ISODate;
                if (v) setAnchor(v);
              }}
              className="pointer-events-none absolute inset-0 size-full opacity-0"
              tabIndex={-1}
              aria-hidden="true"
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            className="size-8 shrink-0 transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]"
            onClick={() => shiftWeek(1)}
            aria-label="Next week"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
      <p className="mb-4 text-sm tabular-nums text-muted-foreground">
        {week} · {weekLabel}
      </p>

      {/* Dim (don't blank) the week's content while a neighbouring week loads —
            keepPreviousData keeps the old numbers up, this signals the swap. */}
      <div
        className={`transition-opacity duration-300 ease-out ${isPlaceholderData ? "opacity-60" : ""}`}
      >
        {/* Stat tiles */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            icon={Target}
            label="Task completion"
            value={`${completion}%`}
            sub={stats ? `${stats.tasksCompleted}/${stats.tasksTotal}` : "—"}
            hero
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
        <div className="zen-card mb-6 p-6">
          <div className="mb-4 flex items-center gap-2 text-base font-semibold">
            <CalendarDays className="size-4 text-muted-foreground" /> Daily task completion
          </div>
          <div>
            {loading ? (
              <div className="flex h-36 items-center justify-center text-sm text-muted-foreground">
                Loading week…
              </div>
            ) : (
              <div className="flex h-36 items-end justify-between gap-2">
                {stats?.perDayCompletion.map((d, i) => {
                  const dow = formatISODate(d.date, { weekday: "short" });
                  const isToday = d.date === today;
                  // Color a day by how much of its tasks got done (higher is better).
                  const tone = !d.total
                    ? "bg-muted-foreground"
                    : d.pct >= 80
                      ? "bg-success"
                      : d.pct >= 40
                        ? "bg-warning"
                        : "bg-info";
                  return (
                    <Reveal
                      as="div"
                      key={d.date}
                      delay={revealDelay(i)}
                      className={`flex flex-1 flex-col items-center gap-1 rounded-lg px-1 pb-1.5 pt-1.5 ${
                        isToday ? "bg-primary/6 ring-1 ring-primary/15" : ""
                      }`}
                    >
                      {/* Faint full-height track so short bars still read against it */}
                      <div className="flex w-full flex-1 items-end overflow-hidden rounded-md bg-muted/30">
                        <div
                          className={`w-full rounded-t transition-[height,opacity] duration-300 ease-out ${tone}`}
                          style={{
                            height: `${Math.max(4, d.pct)}%`,
                            opacity: d.total ? 1 : 0.2,
                          }}
                          title={`${d.pct}% (${d.total} tasks)`}
                        />
                      </div>
                      <div
                        className={`text-[10px] ${
                          isToday ? "font-semibold text-primary" : "text-muted-foreground"
                        }`}
                      >
                        {dow}
                      </div>
                      <div className="text-[10px] tabular-nums text-muted-foreground/70">
                        {d.total ? `${d.pct}%` : "–"}
                      </div>
                    </Reveal>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* AI review */}
        <div className="zen-card mb-6 overflow-hidden p-6">
          <div className="mb-4 flex items-center justify-between text-base font-semibold">
            <span className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Sparkles className="size-4" />
              </span>
              Coach’s Weekly Review
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs font-normal transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]"
              onClick={generate}
              disabled={narrativeLoading || !stats}
            >
              <RefreshCw className={`size-3.5 ${narrativeLoading ? "animate-spin" : ""}`} />
              {narrativeLoading ? "Reflecting…" : "Generate"}
            </Button>
          </div>
          <div className="space-y-4 text-sm">
            {narrative?.reflection && (
              <Reveal
                key={narrative.reflection}
                as="div"
                className="zen-surface-nested p-3 text-pretty leading-6 text-muted-foreground"
              >
                {narrative.reflection}
              </Reveal>
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

            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                className="gap-1.5 transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]"
                onClick={save}
                disabled={saving}
              >
                <Save className="size-4" /> {saving ? "Saving…" : "Save review"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]"
                onClick={scheduleNextWeek}
                disabled={saving || !nextWeekFocus.trim()}
              >
                <ArrowRight className="size-4" /> Schedule next week
              </Button>
              {savedAt && (
                <Reveal as="span" className="text-xs text-muted-foreground">
                  Saved ✓
                </Reveal>
              )}
              {scheduledAt && (
                <Reveal as="span" className="text-xs text-muted-foreground">
                  Scheduled ✓
                </Reveal>
              )}
              {narrative && (
                <span className="text-[10px] text-muted-foreground/60">
                  {narrative.generatedBy === "ai" ? "AI-generated" : "Coach (offline rules)"}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  sub,
  hero,
}: {
  icon: typeof Target;
  label: string;
  value: string;
  sub?: string;
  hero?: boolean;
}) {
  return (
    <div className={`zen-card p-3 ${hero ? "ring-1 ring-primary/20" : ""}`}>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className={`size-3.5 ${hero ? "text-primary" : ""}`} /> {label}
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
