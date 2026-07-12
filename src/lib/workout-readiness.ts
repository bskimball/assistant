import type { WorkoutVariant } from "@/lib/domain";

export type WorkoutReadinessLevel = "good" | "moderate" | "low";

export interface WorkoutReadinessInput {
  yesterdayEnergy?: number;
  latestEffortRating?: number;
  latestSorenessRating?: number;
  daysSinceLastSession?: number;
}

export interface WorkoutReadinessAssessment {
  level: WorkoutReadinessLevel;
  recommendedVariant: WorkoutVariant;
  reasons: string[];
}

/**
 * Select a conservative workout length from the most recent self-reported
 * recovery signals. Missing signals intentionally retain the full plan.
 */
export function assessWorkoutReadiness(input: WorkoutReadinessInput): WorkoutReadinessAssessment {
  const lowReasons: string[] = [];
  if (input.yesterdayEnergy !== undefined && input.yesterdayEnergy <= 2) {
    lowReasons.push("Yesterday’s energy was low.");
  }
  if (input.latestSorenessRating !== undefined && input.latestSorenessRating >= 4) {
    lowReasons.push("Your last workout left high soreness.");
  }
  if (input.latestEffortRating !== undefined && input.latestEffortRating >= 5) {
    lowReasons.push("Your last workout felt very hard.");
  }
  if (lowReasons.length) {
    return { level: "low", recommendedVariant: "minimum", reasons: lowReasons };
  }

  const moderateReasons: string[] = [];
  if (input.yesterdayEnergy === 3) {
    moderateReasons.push("Yesterday’s energy was moderate.");
  }
  if (input.latestSorenessRating === 3) {
    moderateReasons.push("Your last workout left moderate soreness.");
  }
  if (input.latestEffortRating === 4) {
    moderateReasons.push("Your last workout felt hard.");
  }
  if (input.daysSinceLastSession !== undefined && input.daysSinceLastSession < 1) {
    moderateReasons.push("Your last session was less than a day ago.");
  }
  if (moderateReasons.length) {
    return { level: "moderate", recommendedVariant: "short", reasons: moderateReasons };
  }

  return {
    level: "good",
    recommendedVariant: "full",
    reasons: ["No recovery concerns found; the full workout is a good fit."],
  };
}
