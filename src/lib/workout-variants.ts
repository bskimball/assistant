import type { PlannedExercise, PlannedWorkoutSession, WorkoutVariant } from "@/lib/domain";

export interface WorkoutVariantResult {
  variant: WorkoutVariant;
  label: string;
  estimatedMinutes: number;
  exercises: PlannedExercise[];
}

function withReducedSets(exercise: PlannedExercise, maxSets: number): PlannedExercise {
  return { ...exercise, sets: Math.max(1, Math.min(exercise.sets ?? 1, maxSets)) };
}

export function deriveWorkoutVariant(
  session: PlannedWorkoutSession,
  variant: WorkoutVariant,
): WorkoutVariantResult {
  if (variant === "full") {
    return {
      variant,
      label: "Full",
      estimatedMinutes: session.estimatedMinutes,
      exercises: session.exercises.map((exercise) => ({ ...exercise })),
    };
  }

  const main = session.exercises.filter((exercise) => (exercise.phase ?? "main") === "main");
  const warmup = session.exercises.filter((exercise) => exercise.phase === "warmup");
  const support = session.exercises.filter((exercise) =>
    ["accessory", "core", "mobility"].includes(exercise.phase ?? "main"),
  );

  if (variant === "short") {
    const selected = [...warmup.slice(0, 1), ...main.slice(0, 2), ...support.slice(0, 1)];
    return {
      variant,
      label: "Short",
      estimatedMinutes: Math.max(15, Math.round(session.estimatedMinutes * 0.6)),
      exercises: (selected.length ? selected : session.exercises.slice(0, 3)).map((exercise) =>
        withReducedSets(exercise, 2),
      ),
    };
  }

  const primary = main[0] ?? support[0] ?? warmup[0] ?? session.exercises[0];
  return {
    variant,
    label: "Minimum",
    estimatedMinutes: Math.min(10, Math.max(5, Math.round(session.estimatedMinutes * 0.2))),
    exercises: primary ? [withReducedSets(primary, 2)] : [],
  };
}
