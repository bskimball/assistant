import { createFileRoute, Link } from "@tanstack/react-router";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Activity,
  Apple,
  ChevronRight,
  Droplets,
  Dumbbell,
  Ellipsis,
  Plus,
  Utensils,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Item, Stagger } from "@/components/motion";
import {
  HealthQuickLogPanel,
  QuickLogButton,
  type HealthQuickLogKind,
} from "@/components/health/quick-log-panel";
import { useHealthLogging } from "@/hooks/use-health-logging";
import { selectNextHealthAction } from "@/lib/next-health-action";
import { stableRecommendationId } from "@/lib/recommendation-id";
import {
  dashboardQuery,
  nutritionQuery,
  queryKeys,
  recommendationOutcomesQuery,
  userProfileQuery,
  weeklyWorkoutPlanQuery,
  workoutSessionsQuery,
} from "@/lib/queries";
import {
  HOUSEHOLD_TIMEZONE,
  addDaysISO,
  dayBoundsLocal,
  mlToFlOz,
  todayISO,
  toISODate,
  type RecommendationOutcome,
} from "@/lib/domain";
import { completeHealthRecommendation, transitionHealthRecommendation } from "@/server/domain";

const SOURCE = "health-next-action" as const;

export const Route = createFileRoute("/health/")({
  loader: ({ context: { queryClient } }) => {
    const today = todayISO();
    const dates = Array.from({ length: 7 }, (_, index) => addDaysISO(today, -index));
    return Promise.all([
      queryClient.ensureQueryData(dashboardQuery(today)),
      queryClient.ensureQueryData(nutritionQuery(today)),
      queryClient.ensureQueryData(weeklyWorkoutPlanQuery(today)),
      queryClient.ensureQueryData(workoutSessionsQuery()),
      queryClient.ensureQueryData(userProfileQuery()),
      queryClient.ensureQueryData(recommendationOutcomesQuery([today])),
      ...dates.slice(1).map((date) => queryClient.ensureQueryData(dashboardQuery(date))),
    ]);
  },
  component: HealthPage,
});

function HealthPage() {
  const today = todayISO();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  useQuery(dashboardQuery(today));
  const nutrition = useQuery(nutritionQuery(today)).data;
  const plan = useQuery(weeklyWorkoutPlanQuery(today)).data?.plan;
  const sessions =
    useQuery(workoutSessionsQuery()).data?.sessions.filter((session) => !session.deletedAt) ?? [];
  const profile = useQuery(userProfileQuery()).data;
  const outcomesQuery = useQuery(recommendationOutcomesQuery([today]));
  const priorDates = Array.from({ length: 6 }, (_, index) => addDaysISO(today, -(index + 1)));
  const priorDashboards = useQueries({
    queries: priorDates.map((date) => dashboardQuery(date)),
  }).map((query) => query.data);
  const logging = useHealthLogging(today);
  const [quickLog, setQuickLog] = useState<HealthQuickLogKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const todayWorkout = plan?.plannedSessions?.find((session) => session.date === today) ?? null;
  const todaySessions = sessions.filter((session) => toISODate(session.performedAt) === today);
  const latestHealthOutcomes = (outcomesQuery.data ?? [])
    .filter((outcome) => outcome.source === SOURCE)
    .reduce<Map<string, RecommendationOutcome>>((latest, outcome) => {
      const current = latest.get(outcome.id);
      if (!current || outcome.recordedAt >= current.recordedAt) latest.set(outcome.id, outcome);
      return latest;
    }, new Map());
  const terminalTypes = Array.from(latestHealthOutcomes.values())
    .filter(
      (outcome) =>
        outcome.status === "completed" ||
        outcome.status === "dismissed" ||
        outcome.status === "snoozed",
    )
    .flatMap((outcome) => (outcome.health?.actionType ? [outcome.health.actionType] : []));
  const hourLocal = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: HOUSEHOLD_TIMEZONE,
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date()),
  );
  const action = selectNextHealthAction({
    plannedWorkout: todayWorkout,
    workoutCompleted: todaySessions.length > 0,
    mealsLogged: nutrition?.mealLogs.filter((meal) => !meal.deletedAt).length ?? 0,
    proteinG: nutrition?.totals.protein,
    proteinTargetG: profile?.proteinTargetG,
    waterMl: nutrition?.waterMl,
    waterTargetMl: profile?.waterTargetMl,
    hourLocal,
    excludedTypes: terminalTypes,
  });
  const recommendationId = stableRecommendationId(today, SOURCE, action.title);
  const recommendationOutcomes =
    outcomesQuery.data?.filter((outcome) => outcome.id === recommendationId) ?? [];
  const latestOutcome = recommendationOutcomes.reduce<
    (typeof recommendationOutcomes)[number] | undefined
  >(
    (latest, outcome) => (!latest || outcome.recordedAt > latest.recordedAt ? outcome : latest),
    undefined,
  );

  const waterOz = mlToFlOz(nutrition?.waterMl ?? 0) ?? 0;
  const waterTargetOz = mlToFlOz(profile?.waterTargetMl) ?? 85;
  const proteinTarget = profile?.proteinTargetG ?? 150;
  const movementDays = new Set(
    sessions
      .filter((session) => session.performedAt >= dayBoundsLocal(addDaysISO(today, -6)).start)
      .map((session) => toISODate(session.performedAt)),
  ).size;
  const priorMeals = priorDashboards.reduce(
    (sum, item) => sum + (item?.nutrition?.mealLogs.filter((meal) => !meal.deletedAt).length ?? 0),
    0,
  );
  const nutritionDays = [nutrition, ...priorDashboards.map((item) => item?.nutrition)].filter(
    (item): item is NonNullable<typeof item> => Boolean(item),
  );
  const averageProtein = nutritionDays.length
    ? Math.round(
        nutritionDays.reduce((sum, item) => sum + item.totals.protein, 0) / nutritionDays.length,
      )
    : 0;
  const averageWaterOz = nutritionDays.length
    ? Math.round(
        nutritionDays.reduce((sum, item) => sum + (mlToFlOz(item.waterMl ?? 0) ?? 0), 0) /
          nutritionDays.length,
      )
    : 0;

  const evidence =
    action.type === "start-workout"
      ? `${todayWorkout?.estimatedMinutes ?? 0} min planned · ${todaySessions.length} logged today`
      : action.type === "choose-workout"
        ? `${movementDays} active day${movementDays === 1 ? "" : "s"} in the last 7 days`
        : action.type === "log-meal"
          ? `${nutrition?.mealLogs.filter((meal) => !meal.deletedAt).length ?? 0} meals · ${nutrition?.totals.protein ?? 0} of ${proteinTarget} g protein`
          : action.type === "add-water"
            ? `${waterOz} of ${waterTargetOz} fl oz logged`
            : `${todaySessions.length} workout${todaySessions.length === 1 ? "" : "s"} · ${nutrition?.mealLogs.filter((meal) => !meal.deletedAt).length ?? 0} meals today`;

  async function record(statusValue: "accepted" | "dismissed" | "snoozed") {
    await transitionHealthRecommendation({
      data: {
        id: recommendationId,
        date: today,
        text: action.title,
        status: statusValue,
        actionType: action.type,
        criterion: action.criterion,
        targetTitle: action.type === "start-workout" ? todayWorkout?.title : undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: queryKeys.recommendationOutcomes([today]) });
  }

  async function recordQuietAction(statusValue: "dismissed" | "snoozed") {
    setBusy(true);
    setStatus(null);
    try {
      await record(statusValue);
      setStatus(statusValue === "dismissed" ? "Dismissed for today." : "Snoozed for today.");
    } catch (error) {
      console.error("[health] recommendation outcome failed", error);
      setStatus("Couldn’t update that recommendation. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function addQuickWater(amountOz: 8 | 12) {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const linksRecommendation =
        action.type === "add-water" && latestOutcome?.status !== "completed";
      if (linksRecommendation) await record("accepted");
      const water = await logging.addWaterOz(amountOz);
      if (linksRecommendation) {
        try {
          await completeHealthRecommendation({
            data: {
              id: recommendationId,
              date: today,
              actionType: "add-water",
              evidence: {
                kind: "water",
                savedTotalMl: water.savedTotalMl,
                increaseMl: water.increaseMl,
              },
            },
          });
          await queryClient.invalidateQueries({
            queryKey: queryKeys.recommendationOutcomes([today]),
          });
        } catch (feedbackError) {
          console.error("[health] quick water feedback failed", feedbackError);
          setStatus(`Added ${amountOz} fl oz, but couldn’t update the recommendation.`);
          return;
        }
      }
      setStatus(`Added ${amountOz} fl oz of water.`);
    } catch (error) {
      console.error("[health] quick water failed", error);
      setStatus("Couldn’t update water. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function acceptAction() {
    if (action.type === "view-progress") return;
    setBusy(true);
    setStatus(null);
    let accepted = false;
    let healthRecordChanged = false;
    try {
      await record("accepted");
      accepted = true;
      if (action.type === "add-water") {
        const water = await logging.addWaterOz(12);
        healthRecordChanged = true;
        try {
          await completeHealthRecommendation({
            data: {
              id: recommendationId,
              date: today,
              actionType: "add-water",
              evidence: {
                kind: "water",
                savedTotalMl: water.savedTotalMl,
                increaseMl: water.increaseMl,
              },
            },
          });
          await queryClient.invalidateQueries({
            queryKey: queryKeys.recommendationOutcomes([today]),
          });
        } catch (feedbackError) {
          console.error("[health] hydration feedback failed", feedbackError);
          setStatus("Added 12 fl oz, but couldn’t update the recommendation.");
          return;
        }
        setStatus("Added 12 fl oz of water.");
      } else if (action.type === "log-meal") {
        await navigate({
          to: "/health/nutrition",
          search: { healthAction: recommendationId, intent: "log-meal" },
        });
      } else {
        await navigate({
          to: "/health/workouts",
          search: { healthAction: recommendationId, intent: action.type },
        });
      }
    } catch (error) {
      console.error("[health] action failed", error);
      setStatus(
        healthRecordChanged
          ? "Your health record was saved, but the recommendation could not be updated."
          : accepted
            ? "Recommendation accepted, but the next page could not be opened."
            : "That recommendation could not be updated. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitQuickLog(value: { description: string; minutes?: number }) {
    setBusy(true);
    setStatus(null);
    try {
      if (quickLog === "meal") {
        const result = await logging.addMeal(value.description);
        if (
          action.type === "log-meal" &&
          (action.criterion === "meal-timing" || result.estimate.protein > 0)
        ) {
          try {
            await record("accepted");
            await completeHealthRecommendation({
              data: {
                id: recommendationId,
                date: today,
                actionType: "log-meal",
                evidence: { kind: "meal", mealId: result.mealId },
              },
            });
            await queryClient.invalidateQueries({
              queryKey: queryKeys.recommendationOutcomes([today]),
            });
          } catch (feedbackError) {
            console.error("[health] quick meal feedback failed", feedbackError);
            setStatus("Meal logged, but couldn’t update the recommendation.");
            return;
          }
        }
        setStatus("Meal logged.");
      } else {
        const session = await logging.appendSimpleWorkout({
          title: value.description,
          durationMinutes: value.minutes,
        });
        if (action.type === "choose-workout") {
          try {
            await record("accepted");
            await completeHealthRecommendation({
              data: {
                id: recommendationId,
                date: today,
                actionType: "choose-workout",
                evidence: { kind: "workout-session", sessionId: session.id },
              },
            });
            await queryClient.invalidateQueries({
              queryKey: queryKeys.recommendationOutcomes([today]),
            });
          } catch (feedbackError) {
            console.error("[health] quick workout feedback failed", feedbackError);
            setStatus("Workout logged, but couldn’t update the recommendation.");
            return;
          }
        }
        setStatus("Workout logged.");
      }
    } catch (error) {
      console.error("[health] quick log failed", error);
      setStatus("Couldn’t save that log. Try again.");
      throw error;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Stagger>
        <Item as="section" className="zen-card mb-6 p-6" aria-labelledby="health-next-action">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Next action
              </div>
              <h2
                id="health-next-action"
                className="mt-2 text-balance text-2xl font-semibold tracking-tight"
              >
                {action.title}
              </h2>
            </div>
            {action.type !== "view-progress" && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Recommendation options">
                    <Ellipsis className="size-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-40">
                  <Button
                    variant="ghost"
                    className="justify-start"
                    disabled={busy}
                    onClick={() => void recordQuietAction("snoozed")}
                  >
                    Snooze
                  </Button>
                  <Button
                    variant="ghost"
                    className="justify-start"
                    disabled={busy}
                    onClick={() => void recordQuietAction("dismissed")}
                  >
                    Dismiss
                  </Button>
                </PopoverContent>
              </Popover>
            )}
          </div>
          <p className="mt-3 text-sm text-muted-foreground">{action.reason}</p>
          <p className="mt-2 text-xs tabular-nums text-muted-foreground">Evidence: {evidence}</p>
          {latestOutcome?.status === "dismissed" || latestOutcome?.status === "snoozed" ? (
            <p className="mt-4 text-sm text-muted-foreground">
              This recommendation is {latestOutcome.status} for today.
            </p>
          ) : action.type === "view-progress" ? (
            <Button asChild className="mt-5 gap-1.5">
              <Link to="/analytics">
                View trends <ChevronRight className="size-4" />
              </Link>
            </Button>
          ) : (
            <Button className="mt-5 gap-1.5" disabled={busy} onClick={() => void acceptAction()}>
              {action.type === "add-water"
                ? "Add 12 fl oz"
                : action.type === "log-meal"
                  ? "Log meal"
                  : action.type === "start-workout"
                    ? "Start workout"
                    : "Choose workout"}
              <ChevronRight className="size-4" />
            </Button>
          )}
          {status && (
            <p className="mt-3 text-sm text-muted-foreground" role="status">
              {status}
            </p>
          )}
        </Item>

        <Item
          as="section"
          className="mb-6 grid gap-3 sm:grid-cols-3"
          aria-label="Today’s health status"
        >
          <StatusTile
            icon={Activity}
            label="Movement"
            value={
              todaySessions.length
                ? `${todaySessions.length} logged`
                : todayWorkout
                  ? "Planned"
                  : "Open"
            }
            detail={todayWorkout?.title ?? "No session selected"}
          />
          <StatusTile
            icon={Apple}
            label="Fuel"
            value={`${nutrition?.totals.protein ?? 0} g protein`}
            detail={`${nutrition?.mealLogs.filter((meal) => !meal.deletedAt).length ?? 0} meals · ${nutrition?.totals.calories ?? 0} cal`}
          />
          <StatusTile
            icon={Droplets}
            label="Hydration"
            value={`${waterOz} fl oz`}
            detail={`${waterTargetOz} fl oz target`}
          />
        </Item>

        <Item as="section" className="zen-card mb-6 p-6" aria-labelledby="quick-log-title">
          <h2 id="quick-log-title" className="text-base font-semibold">
            Quick log
          </h2>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <QuickLogButton onClick={() => setQuickLog("meal")}>
              <Utensils className="size-4 text-primary" /> Meal
            </QuickLogButton>
            <QuickLogButton onClick={() => setQuickLog("workout")}>
              <Dumbbell className="size-4 text-primary" /> Simple workout
            </QuickLogButton>
            <Button
              variant="outline"
              className="h-auto min-h-11 justify-start gap-2 py-2"
              disabled={busy}
              onClick={() => void addQuickWater(8)}
            >
              <Plus className="size-4 text-primary" /> 8 fl oz water
            </Button>
            <Button
              variant="outline"
              className="h-auto min-h-11 justify-start gap-2 py-2"
              disabled={busy}
              onClick={() => void addQuickWater(12)}
            >
              <Plus className="size-4 text-primary" /> 12 fl oz water
            </Button>
          </div>
        </Item>

        <Item as="section" className="zen-card mb-6 p-6" aria-labelledby="context-title">
          <h2 id="context-title" className="text-base font-semibold">
            7-day context
          </h2>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <div className="text-2xl font-semibold tabular-nums">{movementDays}</div>
              <div className="text-xs text-muted-foreground">days with movement</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums">
                {priorMeals + (nutrition?.mealLogs.filter((meal) => !meal.deletedAt).length ?? 0)}
              </div>
              <div className="text-xs text-muted-foreground">meals logged</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums">{averageProtein} g</div>
              <div className="text-xs text-muted-foreground">average protein</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums">{averageWaterOz} fl oz</div>
              <div className="text-xs text-muted-foreground">average hydration</div>
            </div>
          </div>
        </Item>

        <Item className="grid gap-3 sm:grid-cols-2">
          <DomainLink
            to="/health/workouts"
            icon={Dumbbell}
            title="Workouts"
            detail="Plan, complete, and review sessions"
          />
          <DomainLink
            to="/health/nutrition"
            icon={Utensils}
            title="Nutrition"
            detail="Meals, macros, and hydration"
          />
        </Item>
      </Stagger>
      <HealthQuickLogPanel
        kind={quickLog ?? "meal"}
        open={quickLog !== null}
        onOpenChange={(open) => !open && setQuickLog(null)}
        busy={busy}
        onSubmit={submitQuickLog}
      />
    </>
  );
}

function StatusTile({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="zen-card p-4">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        <Icon className="size-3.5 text-primary" />
        {label}
      </div>
      <div className="mt-2 font-semibold tabular-nums">{value}</div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function DomainLink({
  to,
  icon: Icon,
  title,
  detail,
}: {
  to: "/health/workouts" | "/health/nutrition";
  icon: typeof Dumbbell;
  title: string;
  detail: string;
}) {
  return (
    <Link
      to={to}
      className="zen-card flex items-center gap-3 p-4 outline-none transition-[background-color,box-shadow] hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
      <ChevronRight className="size-4 text-muted-foreground" />
    </Link>
  );
}
