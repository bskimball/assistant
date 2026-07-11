/**
 * AI Coach route-facing server functions (ADR-011).
 *
 * Authentication belongs here; Coach Engine products live in plain
 * implementation modules so they can be reused without crossing the
 * server-function boundary.
 */

import { createServerFn } from "@tanstack/react-start";
import type { ISODate } from "@/lib/domain";
import { todayISO } from "@/lib/domain";
import { requireAuthSession } from "@/lib/auth";
import {
  acceptDailyCoachingPlanImpl,
  collectTrend,
  ensureWeeklyWorkoutPlanImpl,
  generateCoachingImpl,
  profileBlock,
  type CoachSuggestion,
  type CoachingResult,
  type WorkoutSuggestion,
} from "@/server/coach-daily-impl";
import {
  generateWeeklyNarrativeImpl,
  type WeeklyNarrativeResult,
  type WeeklyStatsInput,
} from "@/server/coach-weekly-impl";
import { estimateFoodMacrosImpl, type FoodMacroEstimate } from "@/server/coach-food-impl";

export type {
  CoachDomain,
  CoachSuggestion,
  CoachingResult,
  TrendSignals,
  WorkoutSuggestion,
} from "@/server/coach-daily-impl";
export type { FoodMacroEstimate } from "@/server/coach-food-impl";
export type { WeeklyNarrativeResult, WeeklyStatsInput } from "@/server/coach-weekly-impl";
export { collectTrend, profileBlock };

export const generateCoaching = createServerFn({ method: "POST" })
  .validator((data: { date?: ISODate; force?: boolean }) => data)
  .handler(async ({ data }): Promise<CoachingResult> => {
    await requireAuthSession();
    return generateCoachingImpl(data);
  });

export const ensureWeeklyWorkoutPlan = createServerFn({ method: "POST" })
  .validator((data: { date?: ISODate }) => data)
  .handler(async ({ data }): Promise<{ plan: import("@/lib/domain").WorkoutPlan }> => {
    await requireAuthSession();
    return ensureWeeklyWorkoutPlanImpl(data?.date || todayISO());
  });

export const acceptDailyCoachingPlan = createServerFn({ method: "POST" })
  .validator(
    (data: { date: ISODate; suggestions: CoachSuggestion[]; workout: WorkoutSuggestion }) => data,
  )
  .handler(async ({ data }) => {
    await requireAuthSession();
    return acceptDailyCoachingPlanImpl(data);
  });

export const generateWeeklyNarrative = createServerFn({ method: "POST" })
  .validator((data: WeeklyStatsInput) => data)
  .handler(async ({ data }): Promise<WeeklyNarrativeResult> => {
    await requireAuthSession();
    return generateWeeklyNarrativeImpl(data);
  });

export const estimateFoodMacros = createServerFn({ method: "POST" })
  .validator((data: { description: string }) => data)
  .handler(async ({ data }): Promise<FoodMacroEstimate> => {
    await requireAuthSession();
    return estimateFoodMacrosImpl(data);
  });
