import {
  addDaysISO,
  HOUSEHOLD_TIMEZONE,
  todayISO,
  toISODate,
  type DailyNutrition,
  type ISODate,
  type RecommendationOutcome,
  type UserProfile,
  type WorkoutPlan,
  type WorkoutSession,
} from "@/lib/domain";
import { selectNextHealthAction, type NextHealthActionType } from "@/lib/next-health-action";
import { stableRecommendationId } from "@/lib/recommendation-id";
import { buildEffectivenessReport, type EffectivenessReport } from "@/lib/effectiveness-report";
import { getDomainStore } from "@/server/store";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const LEGACY_OUTCOMES_DOMAIN = "recommendation-outcomes";
const HEALTH_OUTCOMES_V2_DOMAIN = "recommendation-outcomes-v2";
const HEALTH_SOURCE = "health-next-action" as const;
const SOURCES = new Set<RecommendationOutcome["source"]>([
  "coach-daily",
  "coach-weekly",
  "next-best-action",
  "health-next-action",
]);
const STATUSES = new Set<RecommendationOutcome["status"]>([
  "accepted",
  "dismissed",
  "snoozed",
  "completed",
]);

export type RecordRecommendationOutcomeInput = Omit<RecommendationOutcome, "recordedAt">;
export type CompleteHealthRecommendationInput = Pick<RecommendationOutcome, "id" | "date"> & {
  actionType: NextHealthActionType;
  evidence:
    | { kind: "workout-session"; sessionId: string }
    | { kind: "meal"; mealId: string }
    | { kind: "water"; savedTotalMl: number; increaseMl: number };
  helpful?: boolean;
};
export type TransitionHealthRecommendationInput = Pick<
  RecommendationOutcome,
  "id" | "date" | "text"
> & {
  status: "accepted" | "dismissed" | "snoozed";
  actionType: NextHealthActionType;
  criterion: NonNullable<RecommendationOutcome["health"]>["criterion"];
  targetTitle?: string;
};

const HEALTH_ACTIONS = new Set<NextHealthActionType>([
  "start-workout",
  "choose-workout",
  "log-meal",
  "add-water",
  "view-progress",
]);

type HealthOutcomesPayload = { events: RecommendationOutcome[] };

/** Append one immutable, personal-scoped recommendation feedback event. */
export async function recordRecommendationOutcomeImpl(
  data: RecordRecommendationOutcomeInput,
): Promise<RecommendationOutcome> {
  if (data.source === "health-next-action") {
    throw new Error("Health recommendations require the specialized transition endpoint");
  }
  return appendRecommendationOutcome(data);
}

async function appendRecommendationOutcome(
  data: RecordRecommendationOutcomeInput,
): Promise<RecommendationOutcome> {
  if (typeof data.id !== "string" || !data.id.trim()) {
    throw new Error("Recommendation id is required");
  }
  if (typeof data.date !== "string" || !ISO_DATE_PATTERN.test(data.date)) {
    throw new Error("Valid date is required");
  }
  if (typeof data.text !== "string" || !data.text.trim()) {
    throw new Error("Recommendation text is required");
  }
  if (!SOURCES.has(data.source)) {
    throw new Error("Valid recommendation source is required");
  }
  if (!STATUSES.has(data.status)) {
    throw new Error("Valid recommendation status is required");
  }
  if (data.helpful !== undefined && typeof data.helpful !== "boolean") {
    throw new Error("Helpful must be a boolean");
  }
  if (data.taskId !== undefined && (typeof data.taskId !== "string" || !data.taskId.trim())) {
    throw new Error("Task id must be a non-empty string");
  }
  if (data.health && !HEALTH_ACTIONS.has(data.health.actionType)) {
    throw new Error("Valid health action type is required");
  }

  const record: RecommendationOutcome = {
    ...data,
    id: data.id.trim(),
    text: data.text.trim(),
    taskId: data.taskId?.trim() || undefined,
    recordedAt: Date.now(),
  };
  const store = await getDomainStore();
  await store.log.append(LEGACY_OUTCOMES_DOMAIN, record.date, record);
  return record;
}

function latestMatching(outcomes: RecommendationOutcome[], id: string) {
  return outcomes
    .filter((outcome) => outcome.id === id)
    .reduce<RecommendationOutcome | undefined>(
      (latest, outcome) => (!latest || outcome.recordedAt >= latest.recordedAt ? outcome : latest),
      undefined,
    );
}

/** Enforce the Health recommendation lifecycle in the current personal scope. */
export async function transitionHealthRecommendationImpl(
  data: TransitionHealthRecommendationInput,
): Promise<RecommendationOutcome> {
  const id = typeof data.id === "string" ? data.id.trim() : "";
  if (!id) throw new Error("Recommendation id is required");
  if (!ISO_DATE_PATTERN.test(data.date) || data.date !== todayISO()) {
    throw new Error("Health recommendation is stale");
  }
  if (!HEALTH_ACTIONS.has(data.actionType)) throw new Error("Valid health action type is required");
  if (!(["accepted", "dismissed", "snoozed"] as const).includes(data.status)) {
    throw new Error("Valid health transition is required");
  }
  const text = typeof data.text === "string" ? data.text.trim() : "";
  if (!text) throw new Error("Recommendation text is required");

  const store = await getDomainStore();
  const [legacy, nutrition, plans, sessions, profile] = await Promise.all([
    store.log.read<RecommendationOutcome>(LEGACY_OUTCOMES_DOMAIN, data.date),
    store.daily.get<DailyNutrition>("daily-nutrition", data.date),
    store.ref.get<{ plans: WorkoutPlan[] }>("workout-plans.json"),
    store.ref.get<{ sessions: WorkoutSession[] }>("workout-sessions.json"),
    store.ref.get<UserProfile>("user-profile.json"),
  ]);
  const plannedToday = plans?.plans
    .filter((plan) => plan.status === "active" && !plan.deletedAt)
    .flatMap((plan) => plan.plannedSessions ?? [])
    .find((session) => session.date === data.date);
  const workoutCompleted =
    sessions?.sessions.some(
      (session) => !session.deletedAt && toISODate(session.performedAt) === data.date,
    ) ?? false;
  const hourLocal = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: HOUSEHOLD_TIMEZONE,
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date()),
  );
  let result: RecommendationOutcome | undefined;

  await store.daily.update<HealthOutcomesPayload>(
    HEALTH_OUTCOMES_V2_DOMAIN,
    data.date,
    (current) => {
      const events = current?.events ?? [];
      const latest = latestMatching([...legacy, ...events], id);
      if (latest) {
        if (latest.source !== HEALTH_SOURCE)
          throw new Error("Recommendation is not a personal health action");
        if (latest.status === data.status) {
          result = latest;
          return { events };
        }
        throw new Error("Health recommendation transition is not allowed");
      }

      const terminalTypes = [...legacy, ...events]
        .filter((outcome) => outcome.source === HEALTH_SOURCE)
        .reduce<Map<string, RecommendationOutcome>>((latestById, outcome) => {
          const prior = latestById.get(outcome.id);
          if (!prior || outcome.recordedAt >= prior.recordedAt) latestById.set(outcome.id, outcome);
          return latestById;
        }, new Map());
      const action = selectNextHealthAction({
        plannedWorkout: plannedToday ?? null,
        workoutCompleted,
        mealsLogged: nutrition?.mealLogs.filter((meal) => !meal.deletedAt).length ?? 0,
        proteinG: nutrition?.totals.protein,
        proteinTargetG: profile?.proteinTargetG,
        waterMl: nutrition?.waterMl,
        waterTargetMl: profile?.waterTargetMl,
        hourLocal,
        excludedTypes: Array.from(terminalTypes.values())
          .filter(
            (outcome) =>
              outcome.status === "completed" ||
              outcome.status === "dismissed" ||
              outcome.status === "snoozed",
          )
          .flatMap((outcome) => (outcome.health?.actionType ? [outcome.health.actionType] : [])),
      });
      const expectedId = stableRecommendationId(data.date, HEALTH_SOURCE, action.title);
      const targetTitle = data.targetTitle?.trim() || undefined;
      const expectedTarget = action.type === "start-workout" ? plannedToday?.title : undefined;
      if (
        id !== expectedId ||
        text !== action.title ||
        data.actionType !== action.type ||
        data.criterion !== action.criterion ||
        targetTitle !== expectedTarget
      ) {
        throw new Error("Health recommendation does not match the current action");
      }

      const health: NonNullable<RecommendationOutcome["health"]> = {
        actionType: action.type,
        criterion: action.criterion,
      };
      if (expectedTarget) health.targetTitle = expectedTarget;
      if (action.type === "add-water") health.acceptedWaterMl = nutrition?.waterMl ?? 0;
      result = {
        id,
        date: data.date,
        source: HEALTH_SOURCE,
        text,
        status: data.status,
        health,
        recordedAt: Date.now(),
      };
      return { events: [...events, result] };
    },
  );
  return result!;
}

/** Load append-only personal feedback records for the requested day keys. */
export async function loadRecommendationOutcomesImpl(
  dates: ISODate[],
): Promise<RecommendationOutcome[]> {
  if (!Array.isArray(dates) || dates.some((date) => !ISO_DATE_PATTERN.test(date))) {
    throw new Error("Valid dates are required");
  }

  const store = await getDomainStore();
  const records = await Promise.all(
    dates.flatMap((date) => [
      store.log.read<RecommendationOutcome>(LEGACY_OUTCOMES_DOMAIN, date),
      store.daily
        .get<HealthOutcomesPayload>(HEALTH_OUTCOMES_V2_DOMAIN, date)
        .then((payload) => payload?.events ?? []),
    ]),
  );
  const seen = new Set<string>();
  return records.flat().filter((record) => {
    const key = JSON.stringify(record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Complete an accepted health action from the current personal scope. Reading
 * through the scoped store means another member's recommendation is indistinguishable
 * from a nonexistent id and can never be completed by this helper.
 */
export async function completeHealthRecommendationImpl(
  data: CompleteHealthRecommendationInput,
): Promise<RecommendationOutcome> {
  const id = typeof data.id === "string" ? data.id.trim() : "";
  if (!id) throw new Error("Recommendation id is required");
  if (typeof data.date !== "string" || !ISO_DATE_PATTERN.test(data.date)) {
    throw new Error("Valid date is required");
  }
  if (data.helpful !== undefined && typeof data.helpful !== "boolean") {
    throw new Error("Helpful must be a boolean");
  }
  if (data.date !== todayISO()) {
    throw new Error("Health recommendation is stale");
  }

  const store = await getDomainStore();
  const evidence = data.evidence;
  const [legacy, sessions, nutrition] = await Promise.all([
    store.log.read<RecommendationOutcome>(LEGACY_OUTCOMES_DOMAIN, data.date),
    evidence.kind === "workout-session"
      ? store.ref.get<{ sessions: WorkoutSession[] }>("workout-sessions.json")
      : Promise.resolve(null),
    evidence.kind === "meal" || evidence.kind === "water"
      ? store.daily.get<DailyNutrition>("daily-nutrition", data.date)
      : Promise.resolve(null),
  ]);
  const workoutSession =
    evidence.kind === "workout-session"
      ? sessions?.sessions.find((item) => item.id === evidence.sessionId)
      : undefined;
  const meal =
    evidence.kind === "meal"
      ? nutrition?.mealLogs.find((item) => item.id === evidence.mealId && !item.deletedAt)
      : undefined;
  let result: RecommendationOutcome | undefined;

  await store.daily.update<HealthOutcomesPayload>(
    HEALTH_OUTCOMES_V2_DOMAIN,
    data.date,
    (current) => {
      const events = current?.events ?? [];
      const latest = latestMatching([...legacy, ...events], id);
      if (!latest) throw new Error("Health recommendation was not found");
      if (
        latest.date !== data.date ||
        !ISO_DATE_PATTERN.test(latest.date) ||
        !Number.isFinite(latest.recordedAt) ||
        typeof latest.text !== "string" ||
        !latest.text.trim() ||
        !SOURCES.has(latest.source) ||
        !STATUSES.has(latest.status)
      ) {
        throw new Error("Health recommendation record is invalid");
      }
      if (latest.source !== HEALTH_SOURCE) {
        throw new Error("Recommendation is not a personal health action");
      }
      if (latest.status === "completed") {
        if (
          latest.health?.actionType === data.actionType &&
          JSON.stringify(latest.health.evidence) === JSON.stringify(data.evidence)
        ) {
          result = latest;
          return { events };
        }
        throw new Error("Health recommendation is already terminal");
      }
      if (latest.status === "dismissed" || latest.status === "snoozed")
        throw new Error("Health recommendation is already terminal");
      if (latest.status !== "accepted") {
        throw new Error("Health recommendation is not currently accepted");
      }
      if (!latest.health || latest.health.actionType !== data.actionType) {
        throw new Error("Health action type does not match the accepted recommendation");
      }

      if (evidence.kind === "workout-session") {
        if (data.actionType !== "start-workout" && data.actionType !== "choose-workout") {
          throw new Error("Workout evidence does not match this health action");
        }
        if (
          !workoutSession ||
          workoutSession.deletedAt ||
          toISODate(workoutSession.performedAt) !== data.date ||
          workoutSession.performedAt <= latest.recordedAt
        ) {
          throw new Error("Valid workout evidence for today is required");
        }
        if (
          data.actionType === "start-workout" &&
          (!latest.health.targetTitle ||
            workoutSession.plannedSessionTitle !== latest.health.targetTitle)
        ) {
          throw new Error("Workout evidence does not match the planned target");
        }
      } else if (evidence.kind === "meal") {
        if (data.actionType !== "log-meal")
          throw new Error("Meal evidence does not match this health action");
        const protein =
          meal?.foodItems.reduce((sum, item) => sum + (item.macros?.protein ?? 0), 0) ?? 0;
        if (
          !meal ||
          toISODate(meal.timestamp) !== data.date ||
          meal.timestamp <= latest.recordedAt ||
          (latest.health.criterion === "protein-gap" && protein <= 0)
        ) {
          throw new Error("Valid meal evidence for today is required");
        }
      } else {
        if (data.actionType !== "add-water")
          throw new Error("Water evidence does not match this health action");
        const current = nutrition?.waterMl ?? 0;
        const accepted = latest.health.acceptedWaterMl ?? 0;
        if (
          !Number.isFinite(evidence.savedTotalMl) ||
          !Number.isFinite(evidence.increaseMl) ||
          evidence.increaseMl <= 0 ||
          evidence.savedTotalMl < accepted + evidence.increaseMl ||
          current < evidence.savedTotalMl
        ) {
          throw new Error("Valid hydration evidence is required");
        }
      }

      result = {
        id: latest.id,
        date: latest.date,
        source: latest.source,
        text: latest.text,
        status: "completed",
        helpful: data.helpful ?? latest.helpful,
        taskId: latest.taskId,
        health: { ...latest.health, evidence },
        recordedAt: Date.now(),
      };
      return { events: [...events, result] };
    },
  );
  return result!;
}

/** Load and reduce one personal month of immutable recommendation feedback. */
export async function loadMonthlyEffectivenessImpl(month: string): Promise<EffectivenessReport> {
  if (typeof month !== "string" || !ISO_MONTH_PATTERN.test(month)) {
    throw new Error("Valid month is required");
  }

  const dates: ISODate[] = [];
  for (
    let date = `${month}-01` as ISODate;
    date.slice(0, 7) === month;
    date = addDaysISO(date, 1)
  ) {
    dates.push(date);
  }

  const outcomes = await loadRecommendationOutcomesImpl(dates);
  return buildEffectivenessReport(outcomes, month);
}
