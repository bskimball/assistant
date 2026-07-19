import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  weeklyWorkoutPlanQuery,
  workoutSessionsQuery,
  userProfileQuery,
  queryKeys,
} from "@/lib/queries";
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
import { useHealthLogging } from "@/hooks/use-health-logging";
import { validateWorkoutSearch } from "@/lib/health-workflow";
import {
  appendWorkoutSession,
  completeHealthRecommendation,
  deleteWorkoutSession,
  loadDailyPlan,
} from "@/server/domain";
import {
  addDaysISO,
  dayBoundsLocal,
  formatISODate,
  localDayKey,
  todayISO,
  type ExercisePhase,
  type ISODate,
  type PerformedExercise,
  type PlannedExercise,
  type PlannedWorkoutSession,
  type WorkoutVariant,
} from "@/lib/domain";
import { deriveWorkoutVariant } from "@/lib/workout-variants";
import { assessWorkoutReadiness, type WorkoutReadinessAssessment } from "@/lib/workout-readiness";
import { buildMovementHistory, recommendProgressiveOverload } from "@/lib/progressive-overload";
import { PHASE_META, PHASE_ORDER, exerciseImageUrl } from "@/lib/workout-phases";
import { ExerciseDetailDialog, type ExerciseDetail } from "@/components/exercise-detail-dialog";
import {
  BarbellIcon,
  CalendarDotsIcon,
  CaretDownIcon,
  CheckCircleIcon,
  CircleIcon,
  ClockCounterClockwiseIcon,
  ClockIcon,
  FireIcon,
  PlusIcon,
  SparkleIcon,
  TrashIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";

export const Route = createFileRoute("/health/workouts")({
  validateSearch: validateWorkoutSearch,
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

const WEEKDAY = (iso: ISODate) => formatISODate(iso, { weekday: "short" });
const DAYNUM = (iso: ISODate) => formatISODate(iso, { month: "short", day: "numeric" });

/** Local-date key for a timestamp, to match a session to a planned day. */
function dayKey(ts: number): ISODate {
  return localDayKey(ts);
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
  readiness: WorkoutReadinessAssessment;
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
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const queryClient = useQueryClient();
  const planQuery = useQuery(weeklyWorkoutPlanQuery(today));
  const sessionsQuery = useQuery(workoutSessionsQuery());
  const profileQuery = useQuery(userProfileQuery());
  const healthLogging = useHealthLogging(today);
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
  const weekStartTs = weekStart ? dayBoundsLocal(weekStart).start : 0;
  const weekEndTs = weekEnd ? dayBoundsLocal(weekEnd).end : 0;
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

  async function completeWorkflowIfPresent(sessionId: string, plannedTitle?: string) {
    if (!search.healthAction || !search.intent) return;
    if (search.intent === "start-workout" && !plannedTitle) return;
    await completeHealthRecommendation({
      data: {
        id: search.healthAction,
        date: today,
        actionType: search.intent,
        evidence: { kind: "workout-session", sessionId },
      },
    });
    await navigate({ search: { healthAction: undefined, intent: undefined }, replace: true });
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
      if (opts.exercises?.length) {
        const session = await appendWorkoutSession({
          data: {
            performedAt: opts.performedAt ?? Date.now(),
            notes: opts.title,
            durationMinutes: opts.durationMinutes,
            effortRating: opts.effortRating,
            exercises: opts.exercises.map((e) => ({
              name: e.name,
              sets: e.sets,
              reps: e.reps,
              phase: e.phase,
            })),
          },
        });
        await refreshSessions();
        try {
          await completeWorkflowIfPresent(session.id);
        } catch (feedbackError) {
          console.error("[workouts] health recommendation completion failed", feedbackError);
          flash(`Logged: ${opts.title}, but couldn’t update the Health recommendation.`);
          return;
        }
      } else {
        const session = await healthLogging.appendSimpleWorkout({
          title: opts.title,
          durationMinutes: opts.durationMinutes,
          effortRating: opts.effortRating,
          performedAt: opts.performedAt,
        });
        try {
          await completeWorkflowIfPresent(session.id);
        } catch (feedbackError) {
          console.error("[workouts] health recommendation completion failed", feedbackError);
          flash(`Logged: ${opts.title}, but couldn’t update the Health recommendation.`);
          return;
        }
      }
      flash(`Logged: ${opts.title}`);
    } catch (e) {
      console.error("[workouts] log failed", e);
      flash("Couldn’t log that workout — try again.");
    } finally {
      setBusy(false);
    }
  }

  function buildPlannedReview(
    session: PlannedWorkoutSession,
    variant: WorkoutVariant,
    readiness: WorkoutReadinessAssessment,
  ): PlannedCompletionReview {
    const derived = deriveWorkoutVariant(session, variant);
    return {
      session,
      variant,
      readiness,
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
    };
  }

  async function startPlannedReview(session: PlannedWorkoutSession) {
    if (busy) return;
    let yesterdayEnergy: number | undefined;
    try {
      const yesterday = await loadDailyPlan({ data: addDaysISO(today, -1) });
      yesterdayEnergy = yesterday?.eveningCheckIn?.energy;
    } catch (error) {
      console.error("[workouts] readiness check-in load failed", error);
    }

    const latestSession = history[0];
    const readiness = assessWorkoutReadiness({
      yesterdayEnergy,
      latestEffortRating: latestSession?.effortRating,
      latestSorenessRating: latestSession?.sorenessRating,
      daysSinceLastSession: latestSession
        ? Math.max(0, (Date.now() - latestSession.performedAt) / 86_400_000)
        : undefined,
    });
    setPlannedReview(buildPlannedReview(session, readiness.recommendedVariant, readiness));
  }

  function setPlannedReviewVariant(variant: WorkoutVariant) {
    setPlannedReview((current) =>
      current ? buildPlannedReview(current.session, variant, current.readiness) : current,
    );
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
      const savedSession = await appendWorkoutSession({
        data: {
          performedAt,
          planId: plan?.id,
          plannedSessionTitle: session.title,
          variant: plannedReview.variant,
          notes: plannedReview.notes.trim() || session.title,
          durationMinutes: optionalPositiveNumber(plannedReview.durationMinutes),
          effortRating: effort as 1 | 2 | 3 | 4 | 5 | undefined,
          sorenessRating: soreness as 1 | 2 | 3 | 4 | 5 | undefined,
          exercises,
        },
      });
      await refreshSessions();
      try {
        await completeWorkflowIfPresent(savedSession.id, session.title);
      } catch (feedbackError) {
        console.error("[workouts] health recommendation completion failed", feedbackError);
        setPlannedReview(null);
        flash(`Logged: ${session.title}, but couldn’t update the Health recommendation.`);
        return;
      }
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
      logDay === "yesterday" ? new Date(addDaysISO(today, -1) + "T12:00:00").getTime() : undefined;
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
    <>
      {weekRangeLabel ? (
        <div className="mb-6 flex items-center">
          <Badge
            variant="secondary"
            className="w-fit gap-1.5 rounded-full px-3 py-1 text-muted-foreground"
          >
            <CalendarDotsIcon className="size-3.5" weight="duotone" /> Week of {weekRangeLabel}
          </Badge>
        </div>
      ) : null}

      {/* Stat tiles */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          icon={FireIcon}
          label="This week"
          value={`${weekWorkouts}`}
          sub={`of ${targetDays} target`}
          progress={{ value: weekWorkouts, target: targetDays }}
          hero
        />
        <StatTile
          icon={BarbellIcon}
          label="Total logged"
          value={`${sessions.length}`}
          sub="sessions"
        />
        <StatTile
          icon={ClockIcon}
          label="Avg length"
          value={avgMinutes ? `${avgMinutes}` : "—"}
          sub={avgMinutes ? "min / session" : "no data"}
        />
        <StatTile
          icon={ClockCounterClockwiseIcon}
          label="Last workout"
          value={lastSession ? relativeDay(lastSession.performedAt, today) : "—"}
          sub={lastSession?.notes ? truncate(lastSession.notes, 18) : "none yet"}
        />
      </div>

      {status && (
        <div className="zen-card mb-4 px-3 py-2 text-sm text-muted-foreground">{status}</div>
      )}

      {/* This week's plan */}
      <div className="zen-card mb-6 overflow-hidden p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-base font-semibold">
          <span className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <CalendarDotsIcon className="size-4" weight="duotone" />
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
        </div>
        <div>
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
                          {Number(session.date.slice(8, 10))}
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => toggle(key)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="flex items-center gap-1.5 font-medium">
                          {done ? (
                            <CheckCircleIcon
                              className="size-4 shrink-0 text-success"
                              weight="duotone"
                            />
                          ) : (
                            <CircleIcon
                              className="size-4 shrink-0 text-muted-foreground/40"
                              weight="duotone"
                            />
                          )}
                          <span className="truncate">{session.title}</span>
                        </div>
                        <div className="ml-[1.375rem] mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span>{session.focus}</span>
                          <span>·</span>
                          <span className="tabular-nums">~{session.estimatedMinutes} min</span>
                          <CaretDownIcon
                            className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
                            weight="duotone"
                          />
                        </div>
                      </button>

                      {!done && !isFuture && (
                        <Button
                          size="sm"
                          variant={isToday ? "default" : "outline"}
                          className="h-8 shrink-0 gap-1 transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]"
                          disabled={busy}
                          onClick={() => void startPlannedReview(session)}
                        >
                          <PlusIcon className="size-3.5" weight="duotone" /> Log
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
                            className="rounded-full bg-success/10 text-[10px] uppercase tracking-wide text-success transition-colors hover:bg-destructive/10 hover:text-destructive"
                          >
                            Done
                          </Badge>
                        </button>
                      )}
                    </div>

                    {open && (
                      <div className="zen-surface-nested ml-15 mt-3 p-2">
                        <PhasedExerciseList exercises={session.exercises} />
                      </div>
                    )}
                  </Reveal>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {plannedReview && (
        <div className="zen-card mb-6 p-6">
          <div className="mb-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-base font-semibold">
              <span>Review completed workout</span>
              <Badge variant="secondary">{plannedReview.session.title}</Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Adjust what you actually did before saving. Sets and reps start from your plan.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Readiness: {plannedReview.readiness.reasons.join(" ")} Recommended:{" "}
              {plannedReview.readiness.recommendedVariant} workout.
            </p>
            <div className="mt-3 flex flex-wrap gap-2" aria-label="Workout length">
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
                    onClick={() => setPlannedReviewVariant(variant)}
                  >
                    {derived.label} · {derived.estimatedMinutes} min
                  </Button>
                );
              })}
            </div>
          </div>
          <div>
            <div className="space-y-4">
              {plannedReview.exercises.map((exercise, index) => {
                const history = buildMovementHistory(sessions, exercise.planned.name);
                const lastLog = history[0];
                const overload = recommendProgressiveOverload(
                  sessions,
                  exercise.planned.name,
                  exercise.planned.reps,
                );
                const lastLogText = lastLog?.actualWeightLb
                  ? `Last: ${lastLog.actualWeightLb} lb${lastLog.actualReps !== undefined ? ` × ${lastLog.actualReps} reps` : ""}.`
                  : "No previous weight logged.";
                const suggestionText = overload.nextWeightLb
                  ? `${overload.suggestion}: ${overload.nextWeightLb} lb.`
                  : `${overload.suggestion}: hold.`;
                return (
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
                    <p className="mt-2 text-xs text-muted-foreground">
                      {lastLogText} {suggestionText} {overload.reason}
                    </p>
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
                );
              })}

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
                <Button type="button" disabled={busy} onClick={() => void completePlannedReview()}>
                  <CheckCircleIcon className="size-4" weight="duotone" /> Save workout
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quick log */}
      <div className="zen-card p-6 mb-6">
        <div className="mb-4">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <SparkleIcon className="size-4 text-primary" weight="duotone" /> Log a workout
          </h2>
        </div>
        <div>
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
              <PlusIcon className="size-4" weight="duotone" /> Log
            </Button>
          </form>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Logs an ad-hoc session for today or yesterday. Use the “Log” buttons above to record a
            planned session with its full exercise list.
          </p>
        </div>
      </div>

      {/* History */}
      <div className="zen-card p-6">
        <div className="mb-4">
          <h2 className="flex items-center justify-between text-base font-semibold">
            <span className="flex items-center gap-2">
              <ClockCounterClockwiseIcon className="size-4 text-primary" weight="duotone" /> History
            </span>
            <span className="text-sm font-normal tabular-nums text-muted-foreground">
              {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
            </span>
          </h2>
        </div>
        <div>
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
                            <CaretDownIcon
                              className={`size-3.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
                              weight="duotone"
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
                        <TrashIcon className="size-4" weight="duotone" />
                      </Button>
                    </div>
                    {open && exs.length > 0 && (
                      <div className="zen-surface-nested mt-3 p-2">
                        <PhasedExerciseList exercises={exs} />
                      </div>
                    )}
                  </Reveal>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <p className="mt-6 text-[11px] text-muted-foreground/60">
        Plan blends strength, calisthenics, and yoga across the week.{" "}
        <Link to="/profile" className="underline transition-colors hover:text-foreground">
          Tune your training days & styles
        </Link>
        .
      </p>
    </>
  );
}

/** Renders exercises grouped by phase in session order, with silhouette thumbnails. */
function PhasedExerciseList({ exercises }: { exercises: PlannedExercise[] }) {
  const [selected, setSelected] = useState<ExerciseDetail | null>(null);
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
                <ExerciseRow
                  key={i}
                  exercise={e}
                  phase={phase}
                  onSelect={() =>
                    setSelected({
                      name: e.name,
                      sets: e.sets,
                      reps: e.reps,
                      weightLb: e.weightLb,
                      restSec: e.restSec,
                      notes: e.notes,
                      phase,
                    })
                  }
                />
              ))}
            </ul>
          </div>
        );
      })}
      <ExerciseDetailDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        exercise={selected}
      />
    </div>
  );
}

/** A single exercise: silhouette thumbnail + name + sets × reps. */
function ExerciseRow({
  exercise,
  phase,
  onSelect,
}: {
  exercise: PlannedExercise;
  phase: ExercisePhase;
  onSelect: () => void;
}) {
  const meta = PHASE_META[phase];
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const reps = exercise.reps ?? "—";
  const sets = exercise.sets ?? 1;

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-label={`View details for ${exercise.name}`}
        className="group flex w-full items-center gap-3 rounded-xl p-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
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
              <BarbellIcon
                className={`size-5 ${meta.text} ${state === "loading" ? "animate-pulse opacity-50" : "opacity-40"}`}
                weight="duotone"
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
      </button>
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
  icon: PhosphorIcon;
  label: string;
  value: string;
  sub?: string;
  progress?: { value: number; target: number };
  hero?: boolean;
}) {
  const pct = progress
    ? Math.min(100, Math.round((progress.value / Math.max(1, progress.target)) * 100))
    : 0;
  const tone = pct >= 100 ? "bg-success" : pct >= 50 ? "bg-warning" : "bg-info";
  return (
    <div
      className={`zen-card p-4 sm:p-5 flex flex-col justify-between ${hero ? "border-primary/20 ring-1 ring-primary/20 shadow-sm" : ""}`}
    >
      <div>
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          <Icon className={`size-3.5 ${hero ? "text-primary" : ""}`} weight="duotone" /> {label}
        </div>
        <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
        {progress && (
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
            <div
              className={`h-full rounded-full transition-[width] duration-300 ease-out ${tone}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
        {sub && <div className="mt-1.5 truncate text-[11px] text-muted-foreground">{sub}</div>}
      </div>
    </div>
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
  if (key === addDaysISO(today, -1)) return "Yest.";
  return new Date(ts).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}
