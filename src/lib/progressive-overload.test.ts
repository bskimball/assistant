import { describe, expect, it } from "vitest";
import type { WorkoutSession } from "@/lib/domain";
import { buildMovementHistory, recommendProgressiveOverload } from "@/lib/progressive-overload";

function session(
  performedAt: number,
  exercise: WorkoutSession["exercises"][number],
  sorenessRating?: WorkoutSession["sorenessRating"],
): WorkoutSession {
  return {
    id: String(performedAt),
    createdAt: performedAt,
    performedAt,
    sorenessRating,
    exercises: [exercise],
  };
}

describe("buildMovementHistory", () => {
  it("matches names case-insensitively and includes substituted planned names", () => {
    const history = buildMovementHistory(
      [
        session(1, {
          name: "Dumbbell Bench Press",
          plannedName: "Bench Press",
          actualWeightLb: 40,
          actualSets: 3,
          actualReps: 10,
          rpe: 7,
        }),
        session(2, {
          name: " bench press ",
          actualWeightLb: 95,
          actualSets: 3,
          actualReps: 8,
          rpe: 8,
        }),
      ],
      "BENCH PRESS",
    );

    expect(history).toHaveLength(2);
    expect(history[0].actualWeightLb).toBe(95);
    expect(history[1].actualWeightLb).toBe(40);
  });
});

describe("recommendProgressiveOverload", () => {
  it("holds when there is no movement history", () => {
    expect(recommendProgressiveOverload([], "Squat", 5)).toEqual({
      suggestion: "hold",
      reason: "No previous log for this movement yet.",
    });
  });

  it("increases a sub-100 lb load after two target-rep, manageable sessions", () => {
    const sessions = [
      session(2, { name: "Bench Press", actualWeightLb: 95, actualReps: 8, rpe: 8 }),
      session(1, { name: "Bench Press", actualWeightLb: 95, actualReps: 8, rpe: 7.5 }),
    ];

    expect(recommendProgressiveOverload(sessions, "bench press", 8)).toMatchObject({
      suggestion: "increase",
      nextWeightLb: 100,
    });
  });

  it("increases a 100 lb or higher load by 10 lb", () => {
    const sessions = [
      session(2, { name: "Squat", actualWeightLb: 100, actualReps: 5, rpe: 8 }),
      session(1, { name: "Squat", actualWeightLb: 100, actualReps: 5, rpe: 8 }),
    ];

    expect(recommendProgressiveOverload(sessions, "Squat", 5)).toMatchObject({
      suggestion: "increase",
      nextWeightLb: 110,
    });
  });

  it("deloads after near-max effort or high soreness", () => {
    const sessionWithHighSoreness = session(
      1,
      { name: "Deadlift", actualWeightLb: 205, actualReps: 5, rpe: 8 },
      4,
    );
    expect(recommendProgressiveOverload([sessionWithHighSoreness], "Deadlift", 5)).toMatchObject({
      suggestion: "deload",
      nextWeightLb: 185,
    });

    expect(
      recommendProgressiveOverload(
        [session(2, { name: "Deadlift", actualWeightLb: 205, actualReps: 5, rpe: 9.5 })],
        "Deadlift",
        5,
      ),
    ).toMatchObject({ suggestion: "deload", nextWeightLb: 185 });
  });

  it("recommends a deload even when a hard session has no logged weight", () => {
    expect(
      recommendProgressiveOverload(
        [session(1, { name: "Squat", actualReps: 5, rpe: 9.5 })],
        "Squat",
        5,
      ),
    ).toEqual({
      suggestion: "deload",
      reason: "Last session was near-max effort or left high soreness; reduce the load.",
    });
  });

  it("holds without two qualifying sessions", () => {
    expect(
      recommendProgressiveOverload(
        [session(1, { name: "Squat", actualWeightLb: 135, actualReps: 5, rpe: 8 })],
        "Squat",
        5,
      ),
    ).toMatchObject({ suggestion: "hold" });
  });
});
