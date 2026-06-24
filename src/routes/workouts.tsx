import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  Dumbbell,
  Flame,
  CalendarRange,
  CheckCircle2,
  Circle,
  ChevronDown,
  Plus,
  Trash2,
  Clock,
  History as HistoryIcon,
  Sparkles,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  appendWorkoutSession,
  loadUserProfile,
  loadWorkoutSessions,
  saveWorkoutSessions,
} from "@/server/domain";
import { ensureWeeklyWorkoutPlan } from "@/server/coach";
import {
  todayISO,
  type PlannedExercise,
  type PlannedWorkoutSession,
  type WorkoutPlan,
  type WorkoutSession,
} from "@/lib/domain";
import { PHASE_META, PHASE_ORDER } from "@/lib/workout-phases";

export const Route = createFileRoute("/workouts")({
  component: WorkoutsPage,
});

const WEEKDAY = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString([], { weekday: "short" });
const DAYNUM = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString([], { month: "short", day: "numeric" });

/** Local-date key for a timestamp, to match a session to a planned day. */
function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function WorkoutsPage() {
  const today = todayISO();

  const [plan, setPlan] = useState<WorkoutPlan | null>(null);
  const [sessions, setSessions] = useState<WorkoutSession[]>([]);
  const [targetDays, setTargetDays] = useState(3);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Quick-log form
  const [logTitle, setLogTitle] = useState("");
  const [logMinutes, setLogMinutes] = useState("");
  const [logEffort, setLogEffort] = useState(3);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [planRes, sessionStore, profile] = await Promise.all([
        ensureWeeklyWorkoutPlan({ data: { date: today } }),
        loadWorkoutSessions(),
        loadUserProfile(),
      ]);
      setPlan(planRes.plan);
      setSessions((sessionStore?.sessions || []).filter((s) => !s.deletedAt));
      setTargetDays(profile.trainingDaysPerWeek ?? 3);
    } catch (e) {
      console.error("[workouts] load failed", e);
    } finally {
      setLoading(false);
    }
  }, [today]);

  useEffect(() => {
    void load();
  }, [load]);

  function flash(msg: string, ms = 3000) {
    setStatus(msg);
    setTimeout(() => setStatus(null), ms);
  }

  const weekStart = plan?.weekStartDate;
  const weekEnd = plan?.weekEndDate;
  const weekRangeLabel =
    weekStart && weekEnd ? `${DAYNUM(weekStart)} – ${DAYNUM(weekEnd)}` : "";

  // Dates within this week that already have a logged session.
  const loggedDays = new Set(sessions.map((s) => dayKey(s.performedAt)));
  const weekStartTs = weekStart ? new Date(weekStart + "T00:00:00").getTime() : 0;
  const weekEndTs = weekEnd ? new Date(weekEnd + "T23:59:59.999").getTime() : 0;
  const weekWorkouts = sessions.filter(
    (s) => s.performedAt >= weekStartTs && s.performedAt <= weekEndTs,
  ).length;

  const history = [...sessions].sort((a, b) => b.performedAt - a.performedAt);
  const lastSession = history[0];
  const totalMinutes = sessions.reduce((sum, s) => sum + (s.durationMinutes || 0), 0);
  const avgMinutes = sessions.length ? Math.round(totalMinutes / sessions.length) : 0;

  function toggle(key: string) {
    setExpanded((e) => ({ ...e, [key]: !e[key] }));
  }

  async function logSession(opts: {
    title: string;
    durationMinutes?: number;
    effortRating?: 1 | 2 | 3 | 4 | 5;
    exercises?: PlannedExercise[];
    performedAt?: number;
  }) {
    setBusy(true);
    try {
      const session = await appendWorkoutSession({
        data: {
          performedAt: opts.performedAt ?? Date.now(),
          notes: opts.title,
          durationMinutes: opts.durationMinutes,
          effortRating: opts.effortRating,
          exercises: (opts.exercises || []).map((e) => ({
            name: e.name,
            sets: e.sets,
            reps: e.reps,
            phase: e.phase,
          })),
        },
      });
      setSessions((items) => [...items, session]);
      flash(`Logged: ${opts.title}`);
    } catch (e) {
      console.error("[workouts] log failed", e);
      flash("Couldn’t log that workout — try again.");
    } finally {
      setBusy(false);
    }
  }

  function logPlanned(session: PlannedWorkoutSession) {
    // Past planned days are stamped at noon that day; today uses now. Future
    // days can't be logged (a session can't be performed in the future).
    const performedAt =
      session.date === today
        ? Date.now()
        : new Date(session.date + "T12:00:00").getTime();
    void logSession({
      title: session.title,
      durationMinutes: session.estimatedMinutes,
      effortRating: 3,
      exercises: session.exercises,
      performedAt,
    });
  }

  function handleQuickLog(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const title = logTitle.trim();
    if (!title || busy) return;
    const mins = parseInt(logMinutes, 10);
    void logSession({
      title,
      durationMinutes: Number.isFinite(mins) && mins > 0 ? mins : undefined,
      effortRating: logEffort as 1 | 2 | 3 | 4 | 5,
    });
    setLogTitle("");
    setLogMinutes("");
    setLogEffort(3);
  }

  async function handleDelete(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      const now = Date.now();
      const next = sessions.map((s) => (s.id === id ? { ...s, deletedAt: now } : s));
      await saveWorkoutSessions({ data: { sessions: next } });
      setSessions(next.filter((s) => !s.deletedAt));
      flash("Removed workout.");
    } catch (e) {
      console.error("[workouts] delete failed", e);
      flash("Couldn’t remove that workout — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-background px-4 pb-16 pt-8 sm:px-6">
      <div className="mx-auto w-full max-w-page">
        {/* Header */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-xs uppercase tracking-[2px] text-muted-foreground">Fitness</div>
            <h1 className="flex items-center gap-2 text-3xl font-semibold tracking-tighter">
              <Dumbbell className="size-7 text-primary" /> Workouts
            </h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Your week of training — warm-up, main work, core, and cooldown stretch — plus a full
              history of everything you’ve logged.
            </p>
          </div>
          {weekRangeLabel && (
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
              <CalendarRange className="size-3.5" /> Week of {weekRangeLabel}
            </span>
          )}
        </div>

        {/* Stat tiles */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            icon={Flame}
            label="This week"
            value={`${weekWorkouts}`}
            sub={`of ${targetDays} target`}
          />
          <StatTile icon={Dumbbell} label="Total logged" value={`${sessions.length}`} sub="sessions" />
          <StatTile
            icon={Clock}
            label="Avg length"
            value={avgMinutes ? `${avgMinutes}` : "—"}
            sub={avgMinutes ? "min / session" : "no data"}
          />
          <StatTile
            icon={HistoryIcon}
            label="Last workout"
            value={lastSession ? relativeDay(lastSession.performedAt, today) : "—"}
            sub={lastSession?.notes ? truncate(lastSession.notes, 18) : "none yet"}
          />
        </div>

        {status && (
          <div className="mb-4 rounded-lg border bg-accent/40 px-3 py-2 text-sm">{status}</div>
        )}

        {/* This week's plan */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarRange className="size-4 text-primary" /> This Week
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading && !plan ? (
              <div className="py-8 text-center text-sm text-muted-foreground">Loading plan…</div>
            ) : !plan?.plannedSessions?.length ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No plan for this week yet.
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {plan.plannedSessions.map((session) => {
                  const key = `plan-${session.date}`;
                  const isToday = session.date === today;
                  const isFuture = session.date > today;
                  const done = loggedDays.has(session.date);
                  const open = !!expanded[key];
                  return (
                    <li key={key} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex items-center gap-3">
                        {/* Day badge */}
                        <div
                          className={`flex w-12 shrink-0 flex-col items-center rounded-lg border py-1 ${
                            isToday ? "border-primary bg-primary/10" : "border-border"
                          }`}
                        >
                          <span
                            className={`text-[10px] font-medium uppercase ${
                              isToday ? "text-primary" : "text-muted-foreground"
                            }`}
                          >
                            {WEEKDAY(session.date)}
                          </span>
                          <span className="text-sm font-semibold tabular-nums">
                            {new Date(session.date + "T00:00:00").getDate()}
                          </span>
                        </div>

                        <button
                          type="button"
                          onClick={() => toggle(key)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="flex items-center gap-1.5 font-medium">
                            {done ? (
                              <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                            ) : (
                              <Circle className="size-4 shrink-0 text-muted-foreground/40" />
                            )}
                            <span className="truncate">{session.title}</span>
                          </div>
                          <div className="ml-[1.375rem] mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span>{session.focus}</span>
                            <span>·</span>
                            <span className="tabular-nums">~{session.estimatedMinutes} min</span>
                            <ChevronDown
                              className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
                            />
                          </div>
                        </button>

                        {!done && !isFuture && (
                          <Button
                            size="sm"
                            variant={isToday ? "default" : "outline"}
                            className="h-8 shrink-0 gap-1"
                            disabled={busy}
                            onClick={() => logPlanned(session)}
                          >
                            <Plus className="size-3.5" /> Log
                          </Button>
                        )}
                        {done && (
                          <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-500">
                            Done
                          </span>
                        )}
                      </div>

                      {open && (
                        <div className="ml-[3.75rem] mt-3">
                          <PhasedExerciseList exercises={session.exercises} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Quick log */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4 text-primary" /> Log a workout
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleQuickLog} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
              <Input
                value={logTitle}
                onChange={(e) => setLogTitle(e.target.value)}
                placeholder="What did you do? (e.g. Morning run, Push day)"
                disabled={busy}
              />
              <Input
                value={logMinutes}
                onChange={(e) => setLogMinutes(e.target.value)}
                inputMode="numeric"
                placeholder="min"
                className="w-full sm:w-20"
                disabled={busy}
              />
              <div className="flex items-center gap-1.5 rounded-md border px-2.5 text-sm">
                <span className="text-xs text-muted-foreground">Effort</span>
                <select
                  value={logEffort}
                  onChange={(e) => setLogEffort(Number(e.target.value))}
                  className="bg-transparent py-2 text-sm outline-none"
                  disabled={busy}
                  aria-label="Effort rating"
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}/5
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" className="gap-1" disabled={!logTitle.trim() || busy}>
                <Plus className="size-4" /> Log
              </Button>
            </form>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Logs an ad-hoc session for today. Use the “Log” buttons above to record a planned
              session with its full exercise list.
            </p>
          </CardContent>
        </Card>

        {/* History */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              <span className="flex items-center gap-2">
                <HistoryIcon className="size-4 text-primary" /> History
              </span>
              <span className="text-sm font-normal text-muted-foreground">
                {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading && !sessions.length ? (
              <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
            ) : history.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No workouts logged yet. Knock out today’s session above to start your history.
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {history.map((s) => {
                  const key = `hist-${s.id}`;
                  const open = !!expanded[key];
                  const exs = (s.exercises || []) as PlannedExercise[];
                  return (
                    <li key={key} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex items-start justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => exs.length && toggle(key)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{s.notes || "Workout"}</span>
                            {exs.length > 0 && (
                              <ChevronDown
                                className={`size-3.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
                              />
                            )}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                            <span className="tabular-nums">{fullDay(s.performedAt)}</span>
                            {s.durationMinutes ? (
                              <>
                                <span>·</span>
                                <span className="tabular-nums">{s.durationMinutes} min</span>
                              </>
                            ) : null}
                            {s.effortRating ? (
                              <>
                                <span>·</span>
                                <span>effort {s.effortRating}/5</span>
                              </>
                            ) : null}
                            {exs.length ? (
                              <>
                                <span>·</span>
                                <span className="tabular-nums">{exs.length} exercises</span>
                              </>
                            ) : null}
                          </div>
                        </button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                          disabled={busy}
                          onClick={() => handleDelete(s.id)}
                          aria-label="Remove workout"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                      {open && exs.length > 0 && (
                        <div className="mt-3">
                          <PhasedExerciseList exercises={exs} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <p className="mt-6 text-[11px] text-muted-foreground/60">
          Plan blends strength, calisthenics, and yoga across the week.{" "}
          <Link to="/profile" className="underline hover:text-foreground">
            Tune your training days & styles
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

/** Renders exercises grouped by phase in session order. */
function PhasedExerciseList({ exercises }: { exercises: PlannedExercise[] }) {
  const groups = PHASE_ORDER.map((phase) => ({
    phase,
    items: exercises.filter((e) => (e.phase ?? "main") === phase),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      {groups.map(({ phase, items }) => {
        const meta = PHASE_META[phase];
        return (
          <div key={phase}>
            <div className="mb-1 flex items-center gap-1.5">
              <span className={`size-1.5 rounded-full ${meta.dot}`} />
              <span className={`text-[10px] font-semibold uppercase tracking-wide ${meta.text}`}>
                {meta.label}
              </span>
            </div>
            <ul className="space-y-0.5">
              {items.map((e, i) => (
                <li key={i} className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate">{e.name}</span>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                    {e.sets ?? 1} × {String(e.reps ?? "—")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Dumbbell;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5" /> {label}
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        {sub && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function fullDay(ts: number) {
  return new Date(ts).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function relativeDay(ts: number, today: string) {
  const key = dayKey(ts);
  if (key === today) return "Today";
  const yest = new Date(today + "T00:00:00");
  yest.setDate(yest.getDate() - 1);
  const y = `${yest.getFullYear()}-${String(yest.getMonth() + 1).padStart(2, "0")}-${String(yest.getDate()).padStart(2, "0")}`;
  if (key === y) return "Yest.";
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}
