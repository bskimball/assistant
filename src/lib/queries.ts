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

import { queryOptions } from "@tanstack/react-query";
import {
  loadDailyDashboard,
  loadWorkoutSessions,
  loadTransactions,
  loadDailyNutrition,
  loadWeeklyReview,
  loadUserProfile,
} from "@/server/domain";
import { getSimplefinStatus, loadFinanceHub, generateFinanceAdvice } from "@/server/finance";
import { ensureWeeklyWorkoutPlan } from "@/server/coach";
import type { ISODate } from "@/lib/domain";

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

export const financeAdviceQuery = (date: ISODate) =>
  queryOptions({
    queryKey: queryKeys.financeAdvice(date),
    queryFn: () => generateFinanceAdvice({ data: { date } }),
  });
