/**
 * Shared TanStack Query options for the app's domain reads.
 *
 * Each factory wraps an existing server function so the data is cached in the
 * Query cache keyed by its inputs. Pages prime these in their route `loader`
 * (`queryClient.ensureQueryData(...)`) and read them with `useQuery(...)`, so
 * revisiting a page is instant (served from cache) with a background refresh.
 *
 * Mutations should update the cache via `queryClient.setQueryData(key, …)` or
 * mark it stale with `queryClient.invalidateQueries({ queryKey: key })` rather
 * than refetching by hand. Use the exported `queryKeys` for invalidation.
 */

import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import {
  loadDailyDashboard,
  loadWorkoutSessions,
  loadTransactions,
  loadDailyNutrition,
  loadWeeklyReview,
  loadUserProfile,
  loadRecommendationOutcomes,
  loadMonthlyEffectiveness,
} from "@/server/domain";
import { getSimplefinStatus, loadFinanceHub, generateFinanceAdvice } from "@/server/finance";
import { ensureWeeklyWorkoutPlan } from "@/server/coach";
import { todayISO, toISOWeek, mondayOfISO, type ISODate } from "@/lib/domain";
import { loadAnalyticsRange, loadWeeklyData, type AnalyticsRange } from "@/lib/review-data";

export const queryKeys = {
  dashboard: (date: ISODate) => ["dashboard", date] as const,
  workoutSessions: () => ["workoutSessions"] as const,
  weeklyWorkoutPlan: (date: ISODate) => ["weeklyWorkoutPlan", date] as const,
  transactions: () => ["transactions"] as const,
  financeHub: (date: ISODate) => ["financeHub", date] as const,
  simplefinStatus: () => ["simplefinStatus"] as const,
  financeAdvice: (date: ISODate) => ["financeAdvice", date] as const,
  nutrition: (date: ISODate) => ["nutrition", date] as const,
  weeklyReview: (week: string) => ["weeklyReview", week] as const,
  userProfile: () => ["userProfile"] as const,
  recommendationOutcomes: (dates: ISODate[]) => ["recommendationOutcomes", ...dates] as const,
  weeklyData: (week: string) => ["weekly", week] as const,
  analyticsRange: (range: AnalyticsRange, end: ISODate) => ["analytics", range, end] as const,
  monthlyEffectiveness: (month: string) => ["effectiveness", month] as const,
};

export const dashboardQuery = (date: ISODate) =>
  queryOptions({
    queryKey: queryKeys.dashboard(date),
    queryFn: () => loadDailyDashboard({ data: date }),
  });

export const workoutSessionsQuery = () =>
  queryOptions({
    queryKey: queryKeys.workoutSessions(),
    queryFn: () => loadWorkoutSessions(),
  });

export const weeklyWorkoutPlanQuery = (date: ISODate) =>
  queryOptions({
    queryKey: queryKeys.weeklyWorkoutPlan(date),
    queryFn: () => ensureWeeklyWorkoutPlan({ data: { date } }),
  });

export const transactionsQuery = () =>
  queryOptions({
    queryKey: queryKeys.transactions(),
    queryFn: () => loadTransactions(),
  });

export const financeHubQuery = (date: ISODate) =>
  queryOptions({
    queryKey: queryKeys.financeHub(date),
    queryFn: () => loadFinanceHub({ data: date }),
  });

export const simplefinStatusQuery = () =>
  queryOptions({
    queryKey: queryKeys.simplefinStatus(),
    queryFn: () => getSimplefinStatus({ data: {} }),
  });

export const nutritionQuery = (date: ISODate) =>
  queryOptions({
    queryKey: queryKeys.nutrition(date),
    queryFn: () => loadDailyNutrition({ data: date }),
  });

export const weeklyReviewQuery = (week: string) =>
  queryOptions({
    queryKey: queryKeys.weeklyReview(week),
    queryFn: () => loadWeeklyReview({ data: week }),
  });

export const userProfileQuery = () =>
  queryOptions({
    queryKey: queryKeys.userProfile(),
    queryFn: () => loadUserProfile(),
  });

export const recommendationOutcomesQuery = (dates: ISODate[]) =>
  queryOptions({
    queryKey: queryKeys.recommendationOutcomes(dates),
    queryFn: () => loadRecommendationOutcomes({ data: dates }),
  });

export const weeklyDataQuery = (anchor: ISODate) => {
  const week = toISOWeek(mondayOfISO(anchor));
  return queryOptions({
    queryKey: queryKeys.weeklyData(week),
    queryFn: () =>
      loadWeeklyData(anchor, {
        loadDashboard: (date) => loadDailyDashboard({ data: date }),
        loadSessions: () => loadWorkoutSessions(),
        loadReview: (reviewWeek) => loadWeeklyReview({ data: reviewWeek }),
      }),
    placeholderData: keepPreviousData,
  });
};

export const analyticsRangeQuery = (range: AnalyticsRange, end: ISODate = todayISO()) =>
  queryOptions({
    queryKey: queryKeys.analyticsRange(range, end),
    queryFn: () =>
      loadAnalyticsRange(
        range,
        {
          loadDashboard: (date) => loadDailyDashboard({ data: date }),
          loadSessions: () => loadWorkoutSessions(),
          loadTransactions: () => loadTransactions(),
        },
        end,
      ),
    placeholderData: keepPreviousData,
  });

export const monthlyEffectivenessQuery = (month: string) =>
  queryOptions({
    queryKey: queryKeys.monthlyEffectiveness(month),
    queryFn: () => loadMonthlyEffectiveness({ data: month }),
  });

export const financeAdviceQuery = (date: ISODate) =>
  queryOptions({
    queryKey: queryKeys.financeAdvice(date),
    queryFn: () => generateFinanceAdvice({ data: { date } }),
    // Each generation is a multi-second Grok call. The key is day-scoped, so
    // never re-generate on revisit — "Regenerate advice" refetches explicitly.
    staleTime: Infinity,
    gcTime: 24 * 60 * 60_000,
  });
