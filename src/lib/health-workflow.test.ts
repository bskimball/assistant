import { describe, expect, it } from "vitest";
import { validateNutritionSearch, validateWorkoutSearch } from "@/lib/health-workflow";

describe("health workflow search validation", () => {
  it("preserves a valid nutrition date and accepts only a paired meal handoff", () => {
    expect(validateNutritionSearch({ healthAction: "health-abc-123", intent: "log-meal" })).toEqual(
      { date: undefined, healthAction: "health-abc-123", intent: "log-meal" },
    );
    expect(
      validateNutritionSearch({
        date: "2020-01-01",
        healthAction: "health-abc-123",
        intent: "log-meal",
      }),
    ).toEqual({ date: "2020-01-01", healthAction: undefined, intent: undefined });
    expect(
      validateNutritionSearch({
        date: "private text",
        healthAction: "bad value",
        intent: "log-meal",
      }),
    ).toEqual({
      date: undefined,
      healthAction: undefined,
      intent: undefined,
    });
  });

  it("accepts only allowlisted workout intents paired with a stable id", () => {
    expect(validateWorkoutSearch({ healthAction: "health-abc", intent: "start-workout" })).toEqual({
      healthAction: "health-abc",
      intent: "start-workout",
    });
    expect(validateWorkoutSearch({ healthAction: "health-abc", intent: "delete-workout" })).toEqual(
      {
        healthAction: undefined,
        intent: undefined,
      },
    );
  });
});
