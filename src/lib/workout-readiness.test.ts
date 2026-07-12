import { describe, expect, it } from "vitest";
import { assessWorkoutReadiness } from "@/lib/workout-readiness";

describe("assessWorkoutReadiness", () => {
  it("recommends the full workout with no recovery signals", () => {
    expect(assessWorkoutReadiness({})).toEqual({
      level: "good",
      recommendedVariant: "full",
      reasons: ["No recovery concerns found; the full workout is a good fit."],
    });
  });

  it("recommends a short workout for moderate recovery signals", () => {
    const assessment = assessWorkoutReadiness({
      yesterdayEnergy: 3,
      latestEffortRating: 4,
      daysSinceLastSession: 2,
    });

    expect(assessment.level).toBe("moderate");
    expect(assessment.recommendedVariant).toBe("short");
    expect(assessment.reasons).toContain("Yesterday’s energy was moderate.");
    expect(assessment.reasons).toContain("Your last workout felt hard.");
  });

  it("recommends the minimum workout for low recovery", () => {
    const assessment = assessWorkoutReadiness({
      yesterdayEnergy: 2,
      latestSorenessRating: 4,
    });

    expect(assessment).toMatchObject({
      level: "low",
      recommendedVariant: "minimum",
    });
    expect(assessment.reasons).toContain("Yesterday’s energy was low.");
    expect(assessment.reasons).toContain("Your last workout left high soreness.");
  });

  it("uses a short workout when the last session was less than a day ago", () => {
    expect(assessWorkoutReadiness({ daysSinceLastSession: 0.5 })).toMatchObject({
      level: "moderate",
      recommendedVariant: "short",
    });
  });
});
