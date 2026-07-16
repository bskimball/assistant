export type NextHealthActionType =
  | "start-workout"
  | "choose-workout"
  | "log-meal"
  | "add-water"
  | "view-progress";

export interface NextHealthAction {
  type: NextHealthActionType;
  criterion:
    | "planned-workout"
    | "choose-workout"
    | "meal-timing"
    | "protein-gap"
    | "hydration"
    | "on-track";
  title: string;
  reason: string;
  href: "/workouts" | "/nutrition" | "/analytics";
}

export interface NextHealthActionInput {
  plannedWorkout?: { title?: string } | null;
  workoutCompleted?: boolean;
  mealsLogged?: number;
  proteinG?: number;
  proteinTargetG?: number;
  waterMl?: number;
  waterTargetMl?: number;
  hourLocal?: number;
  /** Action types already terminal for this day and therefore not viable again. */
  excludedTypes?: NextHealthActionType[];
}

const PROTEIN_CHECK_HOUR = 16;
const PROTEIN_FLOOR = 0.8;
const WATER_CHECK_HOUR = 14;
const WATER_FLOOR = 0.7;

function progress(current: number | undefined, target: number | undefined): number {
  if (!Number.isFinite(current) || !Number.isFinite(target) || (target ?? 0) <= 0) return 1;
  return Math.max(0, (current ?? 0) / (target ?? 1));
}

/** Select exactly one deterministic, health-only action from today's recorded state. */
export function selectNextHealthAction(input: NextHealthActionInput): NextHealthAction {
  const hour = Number.isFinite(input.hourLocal)
    ? Math.min(23, Math.max(0, Math.floor(input.hourLocal ?? 0)))
    : 0;
  const meals = Number.isFinite(input.mealsLogged) ? Math.max(0, input.mealsLogged ?? 0) : 0;

  const excluded = new Set(input.excludedTypes ?? []);
  const candidates: NextHealthAction[] = [];

  if (!input.workoutCompleted && input.plannedWorkout) {
    candidates.push({
      type: "start-workout",
      criterion: "planned-workout",
      title: input.plannedWorkout.title?.trim() || "Start today’s workout",
      reason: "Your planned session is ready and has not been completed yet.",
      href: "/workouts",
    });
  }

  if (!input.workoutCompleted && !input.plannedWorkout) {
    candidates.push({
      type: "choose-workout",
      criterion: "choose-workout",
      title: "Choose today’s workout",
      reason: "No workout is planned yet. Choose a session that fits the time and energy you have.",
      href: "/workouts",
    });
  }

  const expectedMeals = hour >= 20 ? 3 : hour >= 14 ? 2 : hour >= 10 ? 1 : 0;
  if (meals < expectedMeals) {
    candidates.push({
      type: "log-meal",
      criterion: "meal-timing",
      title: "Log your latest meal",
      reason: `By this time, ${expectedMeals} meal${expectedMeals === 1 ? "" : "s"} would normally be logged; you have ${Math.floor(meals)}.`,
      href: "/nutrition",
    });
  }

  const proteinPct = progress(input.proteinG, input.proteinTargetG);
  if (hour >= PROTEIN_CHECK_HOUR && proteinPct < PROTEIN_FLOOR) {
    candidates.push({
      type: "log-meal",
      criterion: "protein-gap",
      title: "Close today’s protein gap",
      reason: `You are at ${Math.round(proteinPct * 100)}% of today’s protein target.`,
      href: "/nutrition",
    });
  }

  const waterPct = progress(input.waterMl, input.waterTargetMl);
  if (hour >= WATER_CHECK_HOUR && waterPct < WATER_FLOOR) {
    candidates.push({
      type: "add-water",
      criterion: "hydration",
      title: "Catch up on hydration",
      reason: `You are at ${Math.round(waterPct * 100)}% of today’s hydration target.`,
      href: "/nutrition",
    });
  }

  const viable = candidates.find((candidate) => !excluded.has(candidate.type));
  if (viable) return viable;

  return {
    type: "view-progress",
    criterion: "on-track",
    title: "View your health progress",
    reason: "Today’s workout, meal timing, protein, and hydration are on track.",
    href: "/analytics",
  };
}
