import { describe, expect, it } from "vitest";
import { selectNextHealthAction, type NextHealthActionInput } from "@/lib/next-health-action";

const onTrack: NextHealthActionInput = {
  plannedWorkout: { title: "Upper body strength" },
  workoutCompleted: true,
  mealsLogged: 3,
  proteinG: 150,
  proteinTargetG: 150,
  waterMl: 2400,
  waterTargetMl: 2400,
  hourLocal: 20,
};

describe("selectNextHealthAction", () => {
  it("prioritizes starting an incomplete planned workout", () => {
    expect(
      selectNextHealthAction({
        ...onTrack,
        workoutCompleted: false,
        mealsLogged: 0,
        proteinG: 0,
        waterMl: 0,
      }),
    ).toMatchObject({
      type: "start-workout",
      title: "Upper body strength",
      href: "/workouts",
    });
  });

  it("asks the member to choose a workout when none is planned", () => {
    expect(
      selectNextHealthAction({ ...onTrack, plannedWorkout: null, workoutCompleted: false }),
    ).toMatchObject({ type: "choose-workout", href: "/workouts" });
  });

  it.each([
    [9, 0, "view-progress"],
    [10, 0, "log-meal"],
    [13, 1, "view-progress"],
    [14, 1, "log-meal"],
    [20, 2, "log-meal"],
  ] as const)("uses meal timing thresholds at hour %i with %i meals", (hour, meals, type) => {
    expect(
      selectNextHealthAction({ ...onTrack, hourLocal: hour, mealsLogged: meals }),
    ).toMatchObject({ type });
  });

  it("checks protein after 4pm and uses an 80% floor", () => {
    expect(
      selectNextHealthAction({ ...onTrack, hourLocal: 15, proteinG: 79, proteinTargetG: 100 }),
    ).toMatchObject({ type: "view-progress" });
    expect(
      selectNextHealthAction({ ...onTrack, hourLocal: 16, proteinG: 79, proteinTargetG: 100 }),
    ).toMatchObject({ type: "log-meal" });
    expect(
      selectNextHealthAction({ ...onTrack, hourLocal: 16, proteinG: 80, proteinTargetG: 100 }),
    ).toMatchObject({ type: "view-progress" });
  });

  it("checks water after 2pm and uses a 70% floor after protein is satisfied", () => {
    expect(
      selectNextHealthAction({ ...onTrack, hourLocal: 13, waterMl: 69, waterTargetMl: 100 }),
    ).toMatchObject({ type: "view-progress" });
    expect(
      selectNextHealthAction({ ...onTrack, hourLocal: 14, waterMl: 69, waterTargetMl: 100 }),
    ).toMatchObject({ type: "add-water" });
    expect(
      selectNextHealthAction({ ...onTrack, hourLocal: 14, waterMl: 70, waterTargetMl: 100 }),
    ).toMatchObject({ type: "view-progress" });
  });

  it("falls back to progress when all health signals are on track", () => {
    expect(selectNextHealthAction(onTrack)).toEqual({
      type: "view-progress",
      criterion: "on-track",
      title: "View your health progress",
      reason: "Today’s workout, meal timing, protein, and hydration are on track.",
      href: "/analytics",
    });
  });

  it("skips action types already terminal today", () => {
    expect(
      selectNextHealthAction({
        ...onTrack,
        workoutCompleted: false,
        excludedTypes: ["start-workout"],
      }),
    ).toMatchObject({ type: "view-progress" });
  });
});
