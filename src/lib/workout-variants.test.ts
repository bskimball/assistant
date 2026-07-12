import { describe, expect, it } from "vitest";
import { deriveWorkoutVariant } from "@/lib/workout-variants";
import type { PlannedWorkoutSession } from "@/lib/domain";

const session: PlannedWorkoutSession = {
  date: "2026-07-12",
  title: "Strength",
  focus: "Full body",
  estimatedMinutes: 45,
  exercises: [
    { name: "Warm-up", sets: 2, reps: "5 min", phase: "warmup" },
    { name: "Squat", sets: 4, reps: 5, phase: "main" },
    { name: "Bench press", sets: 4, reps: 6, phase: "main" },
    { name: "Plank", sets: 3, reps: "30 sec", phase: "core" },
    { name: "Stretch", sets: 1, reps: "3 min", phase: "cooldown" },
  ],
};

describe("deriveWorkoutVariant", () => {
  it("keeps the complete plan for full", () => {
    expect(deriveWorkoutVariant(session, "full")).toMatchObject({
      estimatedMinutes: 45,
      exercises: session.exercises,
    });
  });

  it("keeps main work and reduces sets for short", () => {
    const result = deriveWorkoutVariant(session, "short");
    expect(result.estimatedMinutes).toBe(27);
    expect(result.exercises.map((exercise) => exercise.name)).toContain("Squat");
    expect(result.exercises.every((exercise) => (exercise.sets ?? 1) <= 2)).toBe(true);
  });

  it("creates a viable minimum session", () => {
    const result = deriveWorkoutVariant(session, "minimum");
    expect(result.estimatedMinutes).toBeGreaterThanOrEqual(5);
    expect(result.estimatedMinutes).toBeLessThanOrEqual(10);
    expect(result.exercises).toHaveLength(1);
    expect(result.exercises[0].name).toBe("Squat");
  });
});
