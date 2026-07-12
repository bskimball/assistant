import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  weeklyWorkoutPlanQuery,
  workoutSessionsQuery,
  userProfileQuery,
  queryKeys,
} from "@/lib/queries";
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
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Reveal, revealDelay } from "@/components/motion";
import { appendWorkoutSession, deleteWorkoutSession } from "@/server/domain";
import {
  todayISO,
  type ExercisePhase,
  type PerformedExercise,
  type PlannedExercise,
  type PlannedWorkoutSession,
  type WorkoutVariant,
} from "@/lib/domain";
import { deriveWorkoutVariant } from "@/lib/workout-variants";
import { PHASE_META, PHASE_ORDER, exerciseImageUrl } from "@/lib/workout-phases";

export const Route = createFileRoute("/workouts")({
  loader: ({ context: { queryClient } }) => {
    const today = todayISO();
    return Promise.all([
      queryClient.ensureQueryData(weeklyWorkoutPlanQuery(today)),
      queryClient.ensureQueryData(workoutSessionsQuery()),
      queryClient.ensureQueryData(userProfileQuery()),
    ]);
  },
  component: WorkoutsPage,
});

const WEEKDAY = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString([], { weekday: "short" });
const DAYNUM = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });

/** Local-date key for a timestamp, to match a session to a planned day. */
function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type CompletionExercise = {
  planned: PlannedExercise;
  name: string;
  actualSets: string;
  actualReps: string;
  actualWeightLb: string;
  rpe: string;
};

type PlannedCompletionReview = {
  session: PlannedWorkoutSession;
  variant: WorkoutVariant;
  durationMinutes: string;
  effortRating: string;
  sorenessRating: string;
  notes: string;
  exercises: CompletionExercise[];
};

function numericField(value: number | string | undefined): string {
  return value === undefined ? "" : String(value);
}

function optionalPositiveNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function WorkoutsPage() {
  const today = todayISO();

  const queryClient = useQueryClient();
  const planQuery = useQuery(weeklyWorkoutPlanQuery(today));
  const sessionsQuery = useQuery(workoutSessionsQuery());
  const profileQuery = useQuery(userProfileQuery());
  const plan = planQuery.data?.plan ?? null;
  const sessions = (sessionsQuery.data?.sessions || []).filter((s) => !s.deletedAt);
  const targetDays = profileQuery.data?.trainingDaysPerWeek ?? 3;
  const loading = planQuery.isPending || sessionsQuery.isPending;

  const refreshSessions = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.workoutSessions() });

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [plannedReview, setPlannedReview] = useState<PlannedCompletionReview | null>(null);

  // Quick-log form
  const [logTitle, setLogTitle] = useState("");
  const [logMinutes, setLogMinutes] = useState("");
  const [logEffort, setLogEffort] = useState(3);
  const [logDay, setLogDay] = useState<"today" | "yesterday">("today");

  function flash(msg: string, ms = 3000) {
    setStatus(msg);
    setTimeout(() => setStatus(null), ms);
  }

  const weekStart = plan?.weekStartDate;
  const weekEnd = plan?.weekEndDate;
  const weekRangeLabel = weekStart && weekEnd ? `${DAYNUM(weekStart)} – ${DAYNUM(weekEnd)}` : "";

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
      await appendWorkoutSession({
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
      await refreshSessions();
      flash(`Logged: ${opts.title}`);
    } catch (e) {
      console.error("[workouts] log failed", e);
      flash("Couldn’t log that workout — try again.");
    } finally {
      setBusy(false);
    }
  }

  function startPlannedReview(session: PlannedWorkoutSession, variant: WorkoutVariant = "full") {
    if (busy) return;
    const derived = deriveWorkoutVariant(session, variant);
    setPlannedReview({
      session,
      variant,
      durationMinutes: String(derived.estimatedMinutes),
      effortRating: "3",
      sorenessRating: "",
      notes: session.title,
      exercises: derived.exercises.map((planned) => ({
        planned,
        name: planned.name,
        actualSets: numericField(planned.sets),
        actualReps: numericField(planned.reps),
        actualWeightLb: numericField(planned.weightLb),
        rpe: "",
      })),
    });
  }

  async function completePlannedReview() {
    if (!plannedReview || busy) return;
    const invalidExercise = plannedReview.exercises.find((exercise) => {
      const sets = Number(exercise.actualSets);
      const weight = Number(exercise.actualWeightLb);
      const rpe = Number(exercise.rpe);
      return (
        (exercise.actualSets.trim() !== "" && (!Number.isInteger(sets) || sets <= 0)) ||
        (exercise.actualWeightLb.trim() !== "" && (!Number.isFinite(weight) || weight <= 0)) ||
        (exercise.rpe.trim() !== "" && (!Number.isFinite(rpe) || rpe < 1 || rpe > 10))
      );
    });
    if (invalidExercise) {
      flash("Use positive whole sets, positive weight, and RPE from 1 to 10.");
      return;
    }
    const duration = Number(plannedReview.durationMinutes);
    if (
      plannedReview.durationMinutes.trim() !== "" &&
      (!Number.isInteger(duration) || duration <= 0)
    ) {
      flash("Duration must be a positive whole number of minutes.");
      return;
    }

    const effort = optionalPositiveNumber(plannedReview.effortRating);
    const soreness = optionalPositiveNumber(plannedReview.sorenessRating);
    if ((effort && effort > 5) || (soreness && soreness > 5)) {
      flash("Effort and soreness must be from 1 to 5.");
      return;
    }

    const { session } = plannedReview;
    // Past planned days are stamped at noon that day; today uses now. Future
    // days can't be logged (a session can't be performed in the future).
    const performedAt =
      session.date === today ? Date.now() : new Date(session.date + "T12:00:00").getTime();
    const exercises: PerformedExercise[] = plannedReview.exercises.map((exercise) => {
      const name = exercise.name.trim() || exercise.planned.name;
      return {
        ...exercise.planned,
        name,
        plannedName: name === exercise.planned.name ? undefined : exercise.planned.name,
        actualSets: optionalPositiveNumber(exercise.actualSets),
        actualReps: exercise.actualReps.trim() || undefined,
        actualWeightLb: optionalPositiveNumber(exercise.actualWeightLb),
        rpe: optionalPositiveNumber(exercise.rpe),
      };
    });

    setBusy(true);
    try {
      await appendWorkoutSession({
        data: {
          performedAt,
          planId: plan?.id,
          variant: plannedReview.variant,
          notes: plannedReview.notes.trim() || session.title,
          durationMinutes: optionalPositiveNumber(plannedReview.durationMinutes),
          effortRating: effort as 1 | 2 | 3 | 4 | 5 | undefined,
          sorenessRating: soreness as 1 | 2 | 3 | 4 | 5 | undefined,
          exercises,
        },
      });
      await refreshSessions();
      setPlannedReview(null);
      flash(`Logged: ${session.title}`);
    } catch (e) {
      console.error("[workouts] planned completion failed", e);
      flash("Couldn’t log that workout — try again.");
    } finally {
      setBusy(false);
    }
  }

  function handleQuickLog(e?: React.SyntheticEvent) {
    if (e) e.preventDefault();
    const title = logTitle.trim();
    if (!title || busy) return;
    const mins = parseInt(logMinutes, 10);
    // Yesterday's sessions are stamped at noon that day, same as planned back-logs.
    const performedAt =
      logDay === "yesterday"
        ? (() => {
            const d = new Date(today + "T12:00:00");
            d.setDate(d.getDate() - 1);
            return d.getTime();
          })()
        : undefined;
    void logSession({
      title,
      durationMinutes: Number.isFinite(mins) && mins > 0 ? mins : undefined,
      effortRating: logEffort as 1 | 2 | 3 | 4 | 5,
      performedAt,
    });
    setLogTitle("");
    setLogMinutes("");
    setLogEffort(3);
    setLogDay("today");
  }

  async function unlogPlanned(date: string) {
    if (busy) return;
    // Un-check = soft-delete the most recent session logged for that day.
    const match = sessions
      .filter((s) => dayKey(s.performedAt) === date)
      .sort((a, b) => b.performedAt - a.performedAt)[0];
    if (!match) return;
    setBusy(true);
    try {
      await deleteWorkoutSession({ data: { id: match.id } });
      await refreshSessions();
      flash("Unchecked — session removed.");
    } catch (e) {
      console.error("[workouts] unlog failed", e);
      flash("Couldn’t uncheck that workout — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      await deleteWorkoutSession({ data: { id } });
      await refreshSessions();
      flash("Removed workout.");
    } catch (e) {
      console.error("[workouts] delete failed", e);
      flash("Couldn’t remove that workout — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-background px-4 pb-28 pt-8 sm:px-6 sm:pb-16">
      <div className="mx-auto w-full max-w-page">
        {/* Header */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-xs tracking-tight text-muted-foreground">Fitness</div>
            <h1 className="text-balance text-3xl font-semibold tracking-tighter">Workouts</h1>
            <p className="mt-2 max-w-xl text-pretty text-sm text-muted-foreground">
              Your week of training — warm-up, main work, core, and cooldown stretch — plus a full
              history of everything you’ve logged.
            </p>
          </div>
          {weekRangeLabel && (
            <Badge
              variant="secondary"
              className="w-fit gap-1.5 rounded-full px-3 py-1 text-muted-foreground"
            >
              <CalendarRange className="size-3.5" /> Week of {weekRangeLabel}
            </Badge>
          )}
        </div>

        {/* Stat tiles */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            icon={Flame}
            label="This week"
            value={`${weekWorkouts}`}
            sub={`of ${targetDays} target`}
            progress={{ value: weekWorkouts, target: targetDays }}
            hero
          />
          <StatTile
            icon={Dumbbell}
            label="Total logged"
            value={`${sessions.length}`}
            sub="sessions"
          />
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
          <div className="mb-4 rounded-lg bg-card px-3 py-2 text-sm text-muted-foreground ring-1 ring-foreground/10">
            {status}
          </div>
        )}

        {/* This week's plan */}
        <Card className="mb-6 overflow-hidden border-primary/20 bg-card shadow-sm">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
              <span className="flex items-center gap-2">
                <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <CalendarRange className="size-4" />
                </span>
                This Week
              </span>
              {plan?.plannedSessions?.length ? (
                <Badge
                  variant="secondary"
                  className="bg-primary/10 text-[10px] uppercase tracking-wide text-primary"
                >
                  {weekWorkouts >= targetDays ? "Target hit" : `${targetDays - weekWorkouts} to go`}
                </Badge>
              ) : null}
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
                {plan.plannedSessions.map((session, i) => {
                  const key = `plan-${session.date}`;
                  const isToday = session.date === today;
                  const isFuture = session.date > today;
                  const done = loggedDays.has(session.date);
                  const open = !!expanded[key];
                  return (
                    <Reveal
                      as="li"
                      key={key}
                      delay={revealDelay(i)}
                      className="py-3 first:pt-0 last:pb-0"
                    >
                      <div className="-mx-2 -my-1 flex items-center gap-3 rounded-lg px-2 py-1 transition-[background-color] hover:bg-muted/30">
                        {/* Day badge */}
                        <div
                          className={`flex w-12 shrink-0 flex-col items-center rounded-lg border py-1 ${
                            isToday ? "border-primary bg-primary/10 shadow-sm" : "border-border"
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
                            className="h-8 shrink-0 gap-1 transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]"
                            disabled={busy}
                            onClick={() => startPlannedReview(session)}
                          >
                            <Plus className="size-3.5" /> Log
                          </Button>
                        )}
                        {done && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void unlogPlanned(session.date)}
                            aria-label={`Uncheck ${session.title}`}
                            title="Uncheck this workout"
                            className="-mx-1 -my-2 shrink-0 px-1 py-2 transition-[scale] duration-150 ease-out active:scale-[0.96] disabled:opacity-50"
                          >
                            <Badge
                              variant="secondary"
                              className="rounded-full bg-emerald-500/10 text-[10px] uppercase tracking-wide text-emerald-600 transition-colors hover:bg-destructive/10 hover:text-destructive dark:text-emerald-500"
                            >
                              Done
                            </Badge>
                          </button>
                        )}
                      </div>

                      {open && (
                        <div className="ml-[3.75rem] mt-3 rounded-[20px] bg-background/70 p-2 shadow-[0_1px_0_rgba(0,0,0,0.05)] ring-1 ring-foreground/10">
                          <PhasedExerciseList exercises={session.exercises} />
                        </div>
                      )}
                    </Reveal>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {plannedReview && (
          <Card className="mb-6 border-primary/30 shadow-sm">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
                <span>Review completed workout</span>
                <Badge variant="secondary">{plannedReview.session.title}</Badge>
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Adjust what you actually did before saving. Sets and reps start from your plan.
              </p>
              <div className="flex flex-wrap gap-2" aria-label="Workout length">
                {(["full", "short", "minimum"] as const).map((variant) => {
                  const derived = deriveWorkoutVariant(plannedReview.session, variant);
                  return (
                    <Button
                      key={variant}
                      type="button"
                      size="sm"
                      variant={plannedReview.variant === variant ? "default" : "outline"}
                      aria-pressed={plannedReview.variant === variant}
                      disabled={busy}
                      onClick={() => startPlannedReview(plannedReview.session, variant)}
                    >
                      {derived.label} · {derived.estimatedMinutes} min
                    </Button>
                  );
                })}
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {plannedReview.exercises.map((exercise, index) => (
                  <div key={index} className="rounded-lg border border-border p-3">
                    <div className="mb-2 text-xs font-medium text-muted-foreground">
                      Planned: {exercise.planned.name}
                    </div>
                    <div className="grid gap-2 sm:grid-cols-5">
                      <Input
                        value={exercise.name}
                        onChange={(e) =>
                          setPlannedReview((current) =>
                            current
                              ? {
                                  ...current,
                                  exercises: current.exercises.map((item, itemIndex) =>
                                    itemIndex === index ? { ...item, name: e.target.value } : item,
                                  ),
                                }
                              : current,
                          )
                        }
                        aria-label={`Performed exercise name for ${exercise.planned.name}`}
                        placeholder="Exercise name"
                        disabled={busy}
                        className="sm:col-span-2"
                      />
                      <Input
                        value={exercise.actualSets}
                        onChange={(e) =>
                          setPlannedReview((current) =>
                            current
                              ? {
                                  ...current,
                                  exercises: current.exercises.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? { ...item, actualSets: e.target.value }
                                      : item,
                                  ),
                                }
                              : current,
                          )
                        }
                        inputMode="numeric"
                        aria-label={`Actual sets for ${exercise.planned.name}`}
                        placeholder="Sets"
                        disabled={busy}
                      />
                      <Input
                        value={exercise.actualReps}
                        onChange={(e) =>
                          setPlannedReview((current) =>
                            current
                              ? {
                                  ...current,
                                  exercises: current.exercises.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? { ...item, actualReps: e.target.value }
                                      : item,
                                  ),
                                }
                              : current,
                          )
                        }
                        aria-label={`Actual reps for ${exercise.planned.name}`}
                        placeholder="Reps"
                        disabled={busy}
                      />
                      <Input
                        value={exercise.actualWeightLb}
                        onChange={(e) =>
                          setPlannedReview((current) =>
                            current
                              ? {
                                  ...current,
                                  exercises: current.exercises.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? { ...item, actualWeightLb: e.target.value }
                                      : item,
                                  ),
                                }
                              : current,
                          )
                        }
                        inputMode="decimal"
                        aria-label={`Actual weight in pounds for ${exercise.planned.name}`}
                        placeholder="Weight lb"
                        disabled={busy}
                      />
                    </div>
                    <div className="mt-2 max-w-32">
                      <Input
                        value={exercise.rpe}
                        onChange={(e) =>
                          setPlannedReview((current) =>
                            current
                              ? {
                                  ...current,
                                  exercises: current.exercises.map((item, itemIndex) =>
                                    itemIndex === index ? { ...item, rpe: e.target.value } : item,
                                  ),
                                }
                              : current,
                          )
                        }
                        inputMode="numeric"
                        aria-label={`RPE for ${exercise.planned.name}`}
                        placeholder="RPE 1–10"
                        disabled={busy}
                      />
                    </div>
                  </div>
                ))}

                <div className="grid gap-2 sm:grid-cols-3">
                  <Input
                    value={plannedReview.durationMinutes}
                    onChange={(e) =>
                      setPlannedReview((current) =>
                        current ? { ...current, durationMinutes: e.target.value } : current,
                      )
                    }
                    inputMode="numeric"
                    aria-label="Workout duration in minutes"
                    placeholder="Duration (min)"
                    disabled={busy}
                  />
                  <Select
                    value={plannedReview.effortRating}
                    onValueChange={(effortRating) =>
                      setPlannedReview((current) =>
                        current ? { ...current, effortRating } : current,
                      )
                    }
                    disabled={busy}
                  >
                    <SelectTrigger aria-label="Session effort rating">
                      <span className="text-xs text-muted-foreground">Effort</span>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {[1, 2, 3, 4, 5].map((rating) => (
                          <SelectItem key={rating} value={String(rating)}>
                            {rating}/5
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Select
                    value={plannedReview.sorenessRating || "none"}
                    onValueChange={(sorenessRating) =>
                      setPlannedReview((current) =>
                        current
                          ? {
                              ...current,
                              sorenessRating: sorenessRating === "none" ? "" : sorenessRating,
                            }
                          : current,
                      )
                    }
                    disabled={busy}
                  >
                    <SelectTrigger aria-label="Soreness rating">
                      <span className="text-xs text-muted-foreground">Soreness</span>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="none">None</SelectItem>
                        {[1, 2, 3, 4, 5].map((rating) => (
                          <SelectItem key={rating} value={String(rating)}>
                            {rating}/5
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <Textarea
                  value={plannedReview.notes}
                  onChange={(e) =>
                    setPlannedReview((current) =>
                      current ? { ...current, notes: e.target.value } : current,
                    )
                  }
                  aria-label="Workout notes"
                  placeholder="Notes (optional)"
                  disabled={busy}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setPlannedReview(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => void completePlannedReview()}
                  >
                    <CheckCircle2 className="size-4" /> Save workout
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Quick log */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4 text-primary" /> Log a workout
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={handleQuickLog}
              className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto_auto_auto]"
            >
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
              <Select
                value={logDay}
                onValueChange={(v) => setLogDay(v as "today" | "yesterday")}
                disabled={busy}
              >
                <SelectTrigger aria-label="Workout day" className="w-full sm:w-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="today">Today</SelectItem>
                    <SelectItem value="yesterday">Yesterday</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Select
                value={String(logEffort)}
                onValueChange={(v) => setLogEffort(Number(v))}
                disabled={busy}
              >
                <SelectTrigger aria-label="Effort rating" className="w-full sm:w-auto">
                  <span className="text-xs text-muted-foreground">Effort</span>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n}/5
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button
                type="submit"
                className="gap-1 transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]"
                disabled={!logTitle.trim() || busy}
              >
                <Plus className="size-4" /> Log
              </Button>
            </form>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Logs an ad-hoc session for today or yesterday. Use the “Log” buttons above to record a
              planned session with its full exercise list.
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
              <span className="text-sm font-normal tabular-nums text-muted-foreground">
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
                {history.map((s, i) => {
                  const key = `hist-${s.id}`;
                  const open = !!expanded[key];
                  const exs = (s.exercises || []) as PlannedExercise[];
                  return (
                    <Reveal
                      as="li"
                      key={key}
                      delay={revealDelay(i)}
                      className="py-3 first:pt-0 last:pb-0"
                    >
                      <div className="-mx-2 -my-1 flex items-start justify-between gap-3 rounded-lg px-2 py-1 transition-[background-color] hover:bg-muted/30">
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
                          className="-my-1 size-10 shrink-0 text-muted-foreground transition-[scale,background-color,color] duration-150 ease-out active:scale-[0.96] hover:text-destructive"
                          disabled={busy}
                          onClick={() => handleDelete(s.id)}
                          aria-label="Remove workout"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                      {open && exs.length > 0 && (
                        <div className="mt-3 rounded-[20px] bg-background/70 p-2 shadow-[0_1px_0_rgba(0,0,0,0.05)] ring-1 ring-foreground/10">
                          <PhasedExerciseList exercises={exs} />
                        </div>
                      )}
                    </Reveal>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <p className="mt-6 text-[11px] text-muted-foreground/60">
          Plan blends strength, calisthenics, and yoga across the week.{" "}
          <Link to="/profile" className="underline transition-colors hover:text-foreground">
            Tune your training days & styles
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

/** Renders exercises grouped by phase in session order, with silhouette thumbnails. */
function PhasedExerciseList({ exercises }: { exercises: PlannedExercise[] }) {
  const groups = PHASE_ORDER.map((phase) => ({
    phase,
    items: exercises.filter((e) => (e.phase ?? "main") === phase),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-5">
      {groups.map(({ phase, items }) => {
        const meta = PHASE_META[phase];
        return (
          <div key={phase}>
            <div className="mb-2 flex items-center gap-1.5">
              <span className={`size-1.5 rounded-full ${meta.dot}`} />
              <span className={`text-[10px] font-semibold uppercase tracking-wide ${meta.text}`}>
                {meta.label}
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <ul className="space-y-1.5">
              {items.map((e, i) => (
                <ExerciseRow key={i} exercise={e} phase={phase} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** A single exercise: silhouette thumbnail + name + sets × reps. */
function ExerciseRow({ exercise, phase }: { exercise: PlannedExercise; phase: ExercisePhase }) {
  const meta = PHASE_META[phase];
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const reps = exercise.reps ?? "—";
  const sets = exercise.sets ?? 1;

  return (
    <li className="group flex items-center gap-3 rounded-xl p-1.5 transition-colors hover:bg-muted/50">
      {/* Silhouette thumbnail — dark frame so one art style reads in both themes. */}
      <div className="relative size-14 shrink-0 overflow-hidden rounded-lg bg-slate-900 outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10">
        {state !== "error" && (
          <img
            src={exerciseImageUrl(exercise.name)}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={() => setState("loaded")}
            onError={() => setState("error")}
            className={`size-full object-contain transition-opacity duration-300 ${
              state === "loaded" ? "opacity-100" : "opacity-0"
            }`}
          />
        )}
        {state !== "loaded" && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Dumbbell
              className={`size-5 ${meta.text} ${state === "loading" ? "animate-pulse opacity-50" : "opacity-40"}`}
            />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium leading-snug">{exercise.name}</div>
        <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">
          {sets} <span className="text-muted-foreground/60">×</span> {String(reps)}
        </div>
      </div>
    </li>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  sub,
  progress,
  hero,
}: {
  icon: typeof Dumbbell;
  label: string;
  value: string;
  sub?: string;
  progress?: { value: number; target: number };
  hero?: boolean;
}) {
  const pct = progress
    ? Math.min(100, Math.round((progress.value / Math.max(1, progress.target)) * 100))
    : 0;
  const tone = pct >= 100 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-500" : "bg-primary";
  return (
    <Card className={hero ? "border-primary/20 bg-card shadow-sm" : undefined}>
      <CardContent className="pt-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className={`size-3.5 ${hero ? "text-primary" : ""}`} /> {label}
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        {progress && (
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-[width] duration-300 ease-out ${tone}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
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
  return new Date(ts).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}
