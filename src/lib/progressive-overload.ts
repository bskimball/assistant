import type { PerformedExercise, WorkoutSession } from "@/lib/domain";

export interface MovementHistoryEntry {
  performedAt: number;
  actualWeightLb?: number;
  actualSets?: number;
  actualReps?: number | string;
  rpe?: number;
  targetReps?: number | string;
  sorenessRating?: WorkoutSession["sorenessRating"];
}

export interface ProgressiveOverloadRecommendation {
  suggestion: "increase" | "hold" | "deload";
  nextWeightLb?: number;
  reason: string;
}

function normalizedMovementName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function exerciseMatches(exercise: PerformedExercise, target: string): boolean {
  return (
    normalizedMovementName(exercise.name) === target ||
    (exercise.plannedName !== undefined && normalizedMovementName(exercise.plannedName) === target)
  );
}

function targetRepsHit(
  reps: number | string | undefined,
  targetReps: number | string | undefined,
): boolean {
  if (typeof reps !== "number" || typeof targetReps !== "number") return false;
  return reps >= targetReps;
}

/** Returns newest-first actual movement logs, matching performed and planned names. */
export function buildMovementHistory(
  sessions: WorkoutSession[],
  exerciseName: string,
): MovementHistoryEntry[] {
  const target = normalizedMovementName(exerciseName);
  if (!target) return [];

  return sessions
    .filter((session) => !session.deletedAt)
    .flatMap((session) =>
      session.exercises
        .filter((exercise) => exerciseMatches(exercise, target))
        .map((exercise) => ({
          performedAt: session.performedAt,
          actualWeightLb: exercise.actualWeightLb,
          actualSets: exercise.actualSets,
          actualReps: exercise.actualReps,
          rpe: exercise.rpe,
          targetReps: exercise.reps,
          sorenessRating: session.sorenessRating,
        })),
    )
    .sort((a, b) => b.performedAt - a.performedAt);
}

function roundToFive(weight: number): number {
  return Math.max(5, Math.round(weight / 5) * 5);
}

export function recommendProgressiveOverload(
  sessions: WorkoutSession[],
  exerciseName: string,
  targetReps?: number | string,
): ProgressiveOverloadRecommendation {
  const history = buildMovementHistory(sessions, exerciseName);
  const latest = history[0];
  if (!latest) {
    return { suggestion: "hold", reason: "No previous log for this movement yet." };
  }

  if (
    (latest.rpe !== undefined && latest.rpe >= 9.5) ||
    (latest.sorenessRating !== undefined && latest.sorenessRating >= 4)
  ) {
    return {
      suggestion: "deload",
      nextWeightLb:
        latest.actualWeightLb === undefined ? undefined : roundToFive(latest.actualWeightLb * 0.9),
      reason: "Last session was near-max effort or left high soreness; reduce the load.",
    };
  }

  const [mostRecent, previous] = history;
  if (
    mostRecent?.actualWeightLb !== undefined &&
    previous?.actualWeightLb !== undefined &&
    mostRecent.rpe !== undefined &&
    previous.rpe !== undefined &&
    mostRecent.rpe <= 8 &&
    previous.rpe <= 8 &&
    targetRepsHit(mostRecent.actualReps, targetReps ?? mostRecent.targetReps) &&
    targetRepsHit(previous.actualReps, targetReps ?? previous.targetReps)
  ) {
    const increase = mostRecent.actualWeightLb < 100 ? 5 : 10;
    return {
      suggestion: "increase",
      nextWeightLb: mostRecent.actualWeightLb + increase,
      reason: "Your last two sessions hit the target reps at manageable effort.",
    };
  }

  return { suggestion: "hold", reason: "Keep the current load and build a consistent record." };
}
