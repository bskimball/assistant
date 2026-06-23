/**
 * Server-side persistence helpers for the Core Domain Model (ADR-002).
 *
 * All reads/writes go through R2 using the key conventions from consolidated ADR-003:
 * - Daily aggregates via getDailyKey(domain, date)
 * - Append-only via getLogKey
 * - Refs via getRefKey
 * - Soft-delete index via recordSoftDelete (meta/deleted/{date}.json shards)
 *
 * Supports soft-delete (deletedAt) uniformly + 7-day hard-delete maintenance.
 *
 * IMPORTANT: Dynamic import of r2 inside handlers to keep server-only.
 */

import { createServerFn } from "@tanstack/react-start";
import type {
  DailyNutrition,
  DailyFinanceSnapshot,
  Transaction,
  DailyPlan,
  WorkoutPlan,
  WorkoutSession,
  ProductivityTask,
  DailyFocusScore,
  WeeklyReview,
  AIInteraction,
  VoiceTranscript,
  VoiceIntent,
  ExerciseLibrary,
  UserProfile,
  ISOWeek,
} from "@/lib/domain";
import { requireAuthSession } from "@/lib/auth";
import * as impl from "@/server/domain-impl";
import type { VoiceProcessResult } from "@/server/domain-impl";

/* =========================================
   USER PROFILE (personalization, ADR-013)
   Long-lived reference: assistant/brian/user-profile.json
   ========================================= */

export const loadUserProfile = createServerFn({ method: "GET" }).handler(async () => {
  return impl.loadUserProfileImpl();
});

export const saveUserProfile = createServerFn({ method: "POST" })
  .validator((profile: Partial<UserProfile>) => profile)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    return impl.saveUserProfileImpl(ctx.data);
  });

/* =========================================
   WORKOUT PLAN (single active invariant)
   ========================================= */

/** Stored as reference for simplicity in v1: assistant/brian/workout-plans.json */
export type WorkoutPlansStore = {
  plans: WorkoutPlan[];
  updatedAt: number;
};

export const loadWorkoutPlans = createServerFn({ method: "GET" }).handler(async () => {
  return impl.loadWorkoutPlansImpl();
});

export const saveWorkoutPlans = createServerFn({ method: "POST" })
  .validator((data: { plans: WorkoutPlan[] }) => data)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    return impl.saveWorkoutPlansImpl(ctx.data);
  });

/* Active plan helper (enforces the invariant at read time too) */
export async function getActiveWorkoutPlan(): Promise<WorkoutPlan | null> {
  return impl.getActiveWorkoutPlanImpl();
}

/* =========================================
   WORKOUT SESSIONS (append or daily list)
   ========================================= */

/** v1: store all sessions under a flat reference (small personal data) */
export type WorkoutSessionsStore = {
  sessions: WorkoutSession[];
  updatedAt: number;
};

export const loadWorkoutSessions = createServerFn({ method: "GET" }).handler(async () => {
  return impl.loadWorkoutSessionsImpl();
});

export const saveWorkoutSessions = createServerFn({ method: "POST" })
  .validator((data: { sessions: WorkoutSession[] }) => data)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    return impl.saveWorkoutSessionsImpl(ctx.data);
  });

/** Append a single completed workout session (quick-log from the dashboard). */
export const appendWorkoutSession = createServerFn({ method: "POST" })
  .validator((session: Omit<WorkoutSession, "id" | "createdAt">) => session)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    return impl.appendWorkoutSessionImpl(ctx.data);
  });

/* =========================================
   DAILY NUTRITION
   ========================================= */

export type DailyNutritionPayload = DailyNutrition & { updatedAt: number };

export const loadDailyNutrition = createServerFn({ method: "GET" })
  .validator((date: ISODate) => date)
  .handler(async ({ data: date }) => {
    return impl.loadDailyNutritionImpl(date);
  });

function emptyMacros(): Macros {
  return impl.emptyMacros();
}

function addMacros(a: Macros, b: Partial<Macros>): Macros {
  return impl.addMacros(a, b);
}

function estimateMacrosFromText(text: string): {
  macros: Macros;
  confidence: "low" | "medium" | "high";
} {
  return impl.estimateMacrosFromText(text);
}

export const saveDailyNutrition = createServerFn({ method: "POST" })
  .validator(
    (payload: {
      date: ISODate;
      nutrition: Omit<DailyNutrition, "id" | "createdAt" | "updatedAt" | "deletedAt" | "date">;
    }) => payload,
  )
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    return impl.saveDailyNutritionImpl(ctx.data);
  });

/* =========================================
   DAILY FINANCE SNAPSHOT
   ========================================= */

export type DailyFinancePayload = DailyFinanceSnapshot & { updatedAt: number };

export const loadDailyFinance = createServerFn({ method: "GET" })
  .validator((date: ISODate) => date)
  .handler(async ({ data: date }): Promise<DailyFinancePayload> => {
    return impl.loadDailyFinanceImpl(date);
  });

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
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    return impl.saveDailyFinanceImpl(ctx.data);
  });

export type TransactionsStore = {
  transactions: Transaction[];
  updatedAt: number;
};

export const loadTransactions = createServerFn({ method: "GET" }).handler(async () => {
  return impl.loadTransactionsImpl();
});

export const saveTransactions = createServerFn({ method: "POST" })
  .validator((data: { transactions: Transaction[] }) => data)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    return impl.saveTransactionsImpl(ctx.data);
  });

export const appendTransaction = createServerFn({ method: "POST" })
  .validator((transaction: Omit<Transaction, "id" | "createdAt">) => transaction)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    return impl.appendTransactionImpl(ctx.data);
  });

/* =========================================
   PRODUCTIVITY TASKS (unified)
   ========================================= */

/** Daily productivity file: assistant/brian/productivity-tasks/{date}.json */
export type ProductivityTasksPayload = {
  tasks: ProductivityTask[];
  updatedAt: number;
};

export const loadProductivityTasksForDay = createServerFn({ method: "GET" })
  .validator((date: ISODate) => date)
  .handler(async ({ data: date }) => {
    return impl.loadProductivityTasksForDayImpl(date);
  });

export const saveProductivityTasksForDay = createServerFn({ method: "POST" })
  .validator((data: { date: ISODate; tasks: ProductivityTask[] }) => data)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    return impl.saveProductivityTasksForDayImpl(ctx.data);
  });

/* =========================================
   DAILY PLAN + FOCUS + WEEKLY REVIEW
   ========================================= */

export type DailyPlanPayload = DailyPlan & { updatedAt: number };

export const loadDailyPlan = createServerFn({ method: "GET" })
  .validator((date: ISODate) => date)
  .handler(async ({ data: date }) => {
    return impl.loadDailyPlanImpl(date);
  });

export const saveDailyPlan = createServerFn({ method: "POST" })
  .validator((plan: DailyPlan) => plan)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    return impl.saveDailyPlanImpl(ctx.data);
  });

export const loadDailyFocusScore = createServerFn({ method: "GET" })
  .validator((date: ISODate) => date)
  .handler(async ({ data: date }) => {
    return impl.loadDailyFocusScoreImpl(date);
  });

export const saveDailyFocusScore = createServerFn({ method: "POST" })
  .validator((score: DailyFocusScore) => score)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    return impl.saveDailyFocusScoreImpl(ctx.data);
  });

export const loadWeeklyReview = createServerFn({ method: "GET" })
  .validator((week: ISOWeek) => week)
  .handler(async ({ data: week }) => {
    return impl.loadWeeklyReviewImpl(week);
  });

export const saveWeeklyReview = createServerFn({ method: "POST" })
  .validator((review: WeeklyReview) => review)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    return impl.saveWeeklyReviewImpl(ctx.data);
  });

/* =========================================
   DAILY DASHBOARD LOADER (ADR-005)
   Unified snapshot + events (jsonl) for current day
   ========================================= */

export interface DailyActivity {
  interactions: AIInteraction[];
  transcripts: VoiceTranscript[];
}

export type DailyDashboardPayload = {
  date: ISODate;
  nutrition: DailyNutritionPayload | null;
  finance: DailyFinancePayload | null;
  productivity: ProductivityTasksPayload;
  plan: DailyPlanPayload | null;
  focus: (DailyFocusScore & { updatedAt: number }) | null;
  recent: DailyActivity;
};

export const loadDailyDashboard = createServerFn({ method: "GET" })
  .validator((date: ISODate) => date)
  .handler(async ({ data: date }): Promise<DailyDashboardPayload> => {
    return impl.loadDailyDashboardImpl(date);
  });

/* =========================================
   AI + VOICE LOGS (append-only)
   ========================================= */

export const appendAIInteraction = createServerFn({ method: "POST" })
  .validator(
    (interaction: Omit<AIInteraction, "id" | "createdAt" | "updatedAt" | "deletedAt">) =>
      interaction,
  )
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    return impl.appendAIInteractionImpl(ctx.data);
  });

export const appendVoiceTranscript = createServerFn({ method: "POST" })
  .validator(
    (transcript: Omit<VoiceTranscript, "id" | "createdAt" | "updatedAt" | "deletedAt">) =>
      transcript,
  )
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    return impl.appendVoiceTranscriptImpl(ctx.data);
  });

/* =========================================
   ADR-004: Voice Interaction Pipeline (STT -> Intent -> Action)
   ========================================= */

/** Lightweight intent used for confirmation + execution. */
export type { VoiceIntent } from "@/lib/domain";
export type { VoiceProcessResult } from "@/server/domain-impl";

/** Main entry for the voice pipeline. Persists transcript + interaction + executes. */
export const processVoiceInput = createServerFn({ method: "POST" })
  .validator((data: { transcriptText: string; language?: string; forceExecute?: boolean }) => data)
  .handler(async (ctx: any): Promise<VoiceProcessResult> => {
    await requireAuthSession(ctx.request);
    return impl.processVoiceInputImpl(ctx.data);
  });

/* =========================================
   EXERCISE LIBRARY (long-lived ref)
   ========================================= */

export const loadExerciseLibrary = createServerFn({ method: "GET" }).handler(async () => {
  return impl.loadExerciseLibraryImpl();
});

export const saveExerciseLibrary = createServerFn({ method: "POST" })
  .validator((lib: ExerciseLibrary) => lib)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    return impl.saveExerciseLibraryImpl(ctx.data);
  });

/* =========================================
   SOFT DELETE + HARD-DELETE SUPPORT (ADR-003)
   ========================================= */

/**
 * Record that a top-level R2 object (daily aggregate file or ref store) was soft-deleted
 * or contains soft-deleted content. Used to feed the sharded delete index.
 */
export async function recordSoftDeletedKey(
  key: string,
  deletedAt: number = Date.now(),
  domain?: string,
): Promise<void> {
  return impl.recordSoftDeletedKeyImpl(key, deletedAt, domain);
}

/** Mark entity deleted (by id) inside a collection store. Writes back.
 *  Also records the container key in the day's soft-delete index shard (best-effort).
 */
export async function softDeleteInStore<T extends BaseEntity>(
  _storeName: string,
  id: string,
  loadFn: () => Promise<{ items?: T[]; [k: string]: any }>,
  saveFn: (payload: any) => Promise<any>,
  containerKey?: string,
  domainHint?: string,
): Promise<void> {
  return impl.softDeleteInStoreImpl(id, loadFn, saveFn, containerKey, domainHint);
}

/**
 * Hard-delete maintenance (ADR-003).
 * Scans the most recent `days` delete index shards and permanently deletes
 * any objects whose deletedAt is older than 7 days.
 * After processing a shard older than the retention window, the shard itself is removed.
 *
 * Safe to call periodically (e.g. from a scheduled Worker or manually).
 * Returns a summary of actions taken.
 */
export async function runHardDeleteMaintenance(daysBack = 8): Promise<{
  shardsScanned: string[];
  objectsDeleted: string[];
  shardsPruned: string[];
}> {
  return impl.runHardDeleteMaintenanceImpl(daysBack);
}
