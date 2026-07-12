/**
 * Route-facing server-function interface for core domain operations.
 *
 * The real domain behavior lives in `domain-impl.ts`; this module owns the
 * TanStack Start server-function boundary and one auth gate for route/client
 * callers. Keep new exports as thin wrappers through `withDomainAuth` so auth
 * behavior stays consistent without open-coding it per operation.
 */

import { createServerFn } from "@tanstack/react-start";
import type {
  DailyNutrition,
  DailyFinanceSnapshot,
  Transaction,
  DailyPlan,
  EveningCheckIn,
  WorkoutPlan,
  WorkoutSession,
  ProductivityTask,
  DailyFocusScore,
  WeeklyReview,
  AIInteraction,
  VoiceTranscript,
  ExerciseLibrary,
  UserProfile,
  RecommendationOutcome,
  ISOWeek,
  ISODate,
  BaseEntity,
} from "@/lib/domain";
import { requireAuthSession } from "@/lib/auth";
import * as impl from "@/server/domain-impl";
import type { RecordRecommendationOutcomeInput, VoiceProcessResult } from "@/server/domain-impl";

async function withDomainAuth<TResult>(handler: () => Promise<TResult>): Promise<TResult> {
  await requireAuthSession();
  return handler();
}

async function withDomainAuthData<TData, TResult>(
  data: TData,
  handler: (data: TData) => Promise<TResult>,
): Promise<TResult> {
  await requireAuthSession();
  return handler(data);
}

export type {
  WorkoutPlansStore,
  WorkoutSessionsStore,
  DailyNutritionPayload,
  DailyFinancePayload,
  TransactionsStore,
  ProductivityTasksPayload,
  DailyPlanPayload,
  DailyActivity,
  DailyDashboardPayload,
  VoiceProcessResult,
  RecordRecommendationOutcomeInput,
} from "@/server/domain-impl";

export type { VoiceIntent } from "@/lib/domain";

export const loadUserProfile = createServerFn({ method: "GET" }).handler(() =>
  withDomainAuth(impl.loadUserProfileImpl),
);

export const saveUserProfile = createServerFn({ method: "POST" })
  .validator((profile: Partial<UserProfile>) => profile)
  .handler(({ data }) => withDomainAuthData(data, impl.saveUserProfileImpl));

export const loadWorkoutPlans = createServerFn({ method: "GET" }).handler(() =>
  withDomainAuth(impl.loadWorkoutPlansImpl),
);

export const saveWorkoutPlans = createServerFn({ method: "POST" })
  .validator((data: { plans: WorkoutPlan[] }) => data)
  .handler(({ data }) => withDomainAuthData(data, impl.saveWorkoutPlansImpl));

export const loadWorkoutSessions = createServerFn({ method: "GET" }).handler(() =>
  withDomainAuth(impl.loadWorkoutSessionsImpl),
);

export const saveWorkoutSessions = createServerFn({ method: "POST" })
  .validator((data: { sessions: WorkoutSession[] }) => data)
  .handler(({ data }) => withDomainAuthData(data, impl.saveWorkoutSessionsImpl));

export const appendWorkoutSession = createServerFn({ method: "POST" })
  .validator((session: Omit<WorkoutSession, "id" | "createdAt">) => session)
  .handler(({ data }) => withDomainAuthData(data, impl.appendWorkoutSessionImpl));

export const deleteWorkoutSession = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(({ data }) => withDomainAuthData(data, impl.deleteWorkoutSessionImpl));

export const loadDailyNutrition = createServerFn({ method: "GET" })
  .validator((date: ISODate) => date)
  .handler(({ data }) => withDomainAuthData(data, impl.loadDailyNutritionImpl));

export const saveDailyNutrition = createServerFn({ method: "POST" })
  .validator(
    (payload: {
      date: ISODate;
      nutrition: Omit<DailyNutrition, "id" | "createdAt" | "updatedAt" | "deletedAt" | "date">;
    }) => payload,
  )
  .handler(({ data }) => withDomainAuthData(data, impl.saveDailyNutritionImpl));

export const loadDailyFinance = createServerFn({ method: "GET" })
  .validator((date: ISODate) => date)
  .handler(({ data }) => withDomainAuthData(data, impl.loadDailyFinanceImpl));

export const saveDailyFinance = createServerFn({ method: "POST" })
  .validator(
    (payload: {
      date: ISODate;
      finance: Omit<
        DailyFinanceSnapshot,
        "id" | "createdAt" | "updatedAt" | "deletedAt" | "netWorth"
      > & {
        netWorth?: number;
      };
    }) => payload,
  )
  .handler(({ data }) => withDomainAuthData(data, impl.saveDailyFinanceImpl));

export const loadTransactions = createServerFn({ method: "GET" }).handler(() =>
  withDomainAuth(impl.loadTransactionsImpl),
);

export const appendTransaction = createServerFn({ method: "POST" })
  .validator((transaction: Omit<Transaction, "id" | "createdAt">) => transaction)
  .handler(({ data }) => withDomainAuthData(data, impl.appendTransactionImpl));

export const loadProductivityTasksForDay = createServerFn({ method: "GET" })
  .validator((date: ISODate) => date)
  .handler(({ data }) => withDomainAuthData(data, impl.loadProductivityTasksForDayImpl));

export const saveProductivityTasksForDay = createServerFn({ method: "POST" })
  .validator((data: { date: ISODate; tasks: ProductivityTask[] }) => data)
  .handler(({ data }) => withDomainAuthData(data, impl.saveProductivityTasksForDayImpl));

export const loadDailyPlan = createServerFn({ method: "GET" })
  .validator((date: ISODate) => date)
  .handler(({ data }) => withDomainAuthData(data, impl.loadDailyPlanImpl));

export const saveDailyPlan = createServerFn({ method: "POST" })
  .validator((plan: DailyPlan) => plan)
  .handler(({ data }) => withDomainAuthData(data, impl.saveDailyPlanImpl));

export const saveEveningCheckIn = createServerFn({ method: "POST" })
  .validator((data: { date: ISODate; checkIn: EveningCheckIn }) => data)
  .handler(({ data }) => withDomainAuthData(data, impl.saveEveningCheckInImpl));

export const recordRecommendationOutcome = createServerFn({ method: "POST" })
  .validator((outcome: RecordRecommendationOutcomeInput) => outcome)
  .handler(({ data }) => withDomainAuthData(data, impl.recordRecommendationOutcomeImpl));

export const loadRecommendationOutcomes = createServerFn({ method: "GET" })
  .validator((dates: ISODate[]) => dates)
  .handler(
    ({ data }): Promise<RecommendationOutcome[]> =>
      withDomainAuthData(data, impl.loadRecommendationOutcomesImpl),
  );

export const loadDailyFocusScore = createServerFn({ method: "GET" })
  .validator((date: ISODate) => date)
  .handler(({ data }) => withDomainAuthData(data, impl.loadDailyFocusScoreImpl));

export const saveDailyFocusScore = createServerFn({ method: "POST" })
  .validator((score: DailyFocusScore) => score)
  .handler(({ data }) => withDomainAuthData(data, impl.saveDailyFocusScoreImpl));

export const loadWeeklyReview = createServerFn({ method: "GET" })
  .validator((week: ISOWeek) => week)
  .handler(({ data }) => withDomainAuthData(data, impl.loadWeeklyReviewImpl));

export const saveWeeklyReview = createServerFn({ method: "POST" })
  .validator((review: WeeklyReview) => review)
  .handler(({ data }) => withDomainAuthData(data, impl.saveWeeklyReviewImpl));

export const loadDailyDashboard = createServerFn({ method: "GET" })
  .validator((date: ISODate) => date)
  .handler(({ data }) => withDomainAuthData(data, impl.loadDailyDashboardImpl));

export const appendAIInteraction = createServerFn({ method: "POST" })
  .validator(
    (interaction: Omit<AIInteraction, "id" | "createdAt" | "updatedAt" | "deletedAt">) =>
      interaction,
  )
  .handler(({ data }) => withDomainAuthData(data, impl.appendAIInteractionImpl));

export const appendVoiceTranscript = createServerFn({ method: "POST" })
  .validator(
    (transcript: Omit<VoiceTranscript, "id" | "createdAt" | "updatedAt" | "deletedAt">) =>
      transcript,
  )
  .handler(({ data }) => withDomainAuthData(data, impl.appendVoiceTranscriptImpl));

export const processVoiceInput = createServerFn({ method: "POST" })
  .validator((data: { transcriptText: string; language?: string; forceExecute?: boolean }) => data)
  .handler(
    ({ data }): Promise<VoiceProcessResult> => withDomainAuthData(data, impl.processVoiceInputImpl),
  );

export const loadExerciseLibrary = createServerFn({ method: "GET" }).handler(() =>
  withDomainAuth(impl.loadExerciseLibraryImpl),
);

export const saveExerciseLibrary = createServerFn({ method: "POST" })
  .validator((lib: ExerciseLibrary) => lib)
  .handler(({ data }) => withDomainAuthData(data, impl.saveExerciseLibraryImpl));

export async function recordSoftDeletedKey(
  key: string,
  deletedAt: number = Date.now(),
  domain?: string,
): Promise<void> {
  return impl.recordSoftDeletedKeyImpl(key, deletedAt, domain);
}

export async function softDeleteInStore<T extends BaseEntity>(
  _storeName: string,
  id: string,
  loadFn: Parameters<typeof impl.softDeleteInStoreImpl<T>>[1],
  saveFn: Parameters<typeof impl.softDeleteInStoreImpl<T>>[2],
  containerKey?: string,
  domainHint?: string,
): Promise<void> {
  return impl.softDeleteInStoreImpl(id, loadFn, saveFn, containerKey, domainHint);
}

export async function runHardDeleteMaintenance(daysBack = 8): Promise<{
  shardsScanned: string[];
  objectsDeleted: string[];
  shardsPruned: string[];
}> {
  return impl.runHardDeleteMaintenanceImpl(daysBack);
}
