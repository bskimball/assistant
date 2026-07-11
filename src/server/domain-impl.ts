/**
 * Plain server domain facade.
 *
 * Cohesive CRUD remains here; behavior-heavy clusters live in dedicated plain
 * implementation modules and are re-exported to preserve this module's public
 * interface for existing callers.
 */

import type {
  AIInteraction,
  ChatConversation,
  ChatConversationsStore,
  CoachMemoriesStore,
  CoachMemory,
  ExerciseLibrary,
  UserProfile,
  VoiceTranscript,
  WorkoutPlan,
  WorkoutSession,
} from "@/lib/domain";
import {
  assertSingleActiveWorkoutPlan,
  assertValidWorkoutSessionDate,
  createDefaultUserProfile,
} from "@/lib/domain";
import { getDomainStore } from "@/server/store";

export type WorkoutPlansStore = {
  plans: WorkoutPlan[];
  updatedAt: number;
};

export type WorkoutSessionsStore = {
  sessions: WorkoutSession[];
  updatedAt: number;
};

export async function loadUserProfileImpl(): Promise<UserProfile> {
  const store = await getDomainStore();
  const stored = await store.ref.get<UserProfile>("user-profile.json");
  return stored ?? createDefaultUserProfile();
}

export async function saveUserProfileImpl(data: Partial<UserProfile>): Promise<UserProfile> {
  const store = await getDomainStore();
  const existing =
    (await store.ref.get<UserProfile>("user-profile.json")) ?? createDefaultUserProfile();
  const now = Date.now();
  const next: UserProfile = {
    ...existing,
    ...data,
    id: "user-profile",
    createdAt: existing.createdAt ?? now,
    updatedAt: now,
  };
  await store.ref.put("user-profile.json", next);
  return next;
}

export async function loadChatConversationsImpl(): Promise<ChatConversationsStore> {
  const store = await getDomainStore();
  return (
    (await store.ref.get<ChatConversationsStore>("chat-conversations.json")) ?? {
      conversations: [],
      updatedAt: Date.now(),
    }
  );
}

/**
 * Atomically mutate the chat history (etag CAS + retry) so two tabs saving
 * turns concurrently can't drop each other's conversations. `mutate` may run
 * more than once on conflict — keep it pure over its input.
 */
export async function updateChatConversationsImpl(
  mutate: (conversations: ChatConversation[]) => ChatConversation[],
): Promise<ChatConversationsStore> {
  const store = await getDomainStore();
  return store.ref.update<ChatConversationsStore>("chat-conversations.json", (current) => ({
    conversations: mutate(current?.conversations ?? []),
    updatedAt: Date.now(),
  }));
}

export async function loadCoachMemoriesImpl(): Promise<CoachMemoriesStore> {
  const store = await getDomainStore();
  return (
    (await store.ref.get<CoachMemoriesStore>("coach-memories.json")) ?? {
      memories: [],
      updatedAt: Date.now(),
    }
  );
}

/**
 * Atomically mutate coach memories (etag CAS + retry) so two tabs saving
 * memories concurrently can't drop each other's facts. `mutate` may run more
 * than once on conflict — keep it pure over its input.
 */
export async function updateCoachMemoriesImpl(
  mutate: (memories: CoachMemory[]) => CoachMemory[],
): Promise<CoachMemoriesStore> {
  const store = await getDomainStore();
  return store.ref.update<CoachMemoriesStore>("coach-memories.json", (current) => ({
    memories: mutate(current?.memories ?? []),
    updatedAt: Date.now(),
  }));
}

export async function loadWorkoutPlansImpl(): Promise<WorkoutPlansStore> {
  const store = await getDomainStore();
  return (
    (await store.ref.get<WorkoutPlansStore>("workout-plans.json")) ?? {
      plans: [],
      updatedAt: Date.now(),
    }
  );
}

export async function saveWorkoutPlansImpl(data: {
  plans: WorkoutPlan[];
}): Promise<WorkoutPlansStore> {
  assertSingleActiveWorkoutPlan(data.plans);
  const payload: WorkoutPlansStore = {
    plans: data.plans,
    updatedAt: Date.now(),
  };
  const store = await getDomainStore();
  await store.ref.put("workout-plans.json", payload);
  return payload;
}

export async function getActiveWorkoutPlanImpl(): Promise<WorkoutPlan | null> {
  const store = await loadWorkoutPlansImpl();
  return store.plans.find((p) => p.status === "active" && !p.deletedAt) ?? null;
}

export async function loadWorkoutSessionsImpl(): Promise<WorkoutSessionsStore> {
  const store = await getDomainStore();
  return (
    (await store.ref.get<WorkoutSessionsStore>("workout-sessions.json")) ?? {
      sessions: [],
      updatedAt: Date.now(),
    }
  );
}

export async function saveWorkoutSessionsImpl(data: {
  sessions: WorkoutSession[];
}): Promise<WorkoutSessionsStore> {
  const now = Date.now();
  data.sessions.forEach((s) => {
    if (!s.deletedAt) assertValidWorkoutSessionDate(s.performedAt, now);
  });
  const payload: WorkoutSessionsStore = {
    sessions: data.sessions,
    updatedAt: now,
  };
  const store = await getDomainStore();
  await store.ref.put("workout-sessions.json", payload);
  return payload;
}

export async function appendWorkoutSessionImpl(
  data: Omit<WorkoutSession, "id" | "createdAt">,
): Promise<WorkoutSession> {
  const now = Date.now();
  assertValidWorkoutSessionDate(data.performedAt ?? now, now);
  const stored = await loadWorkoutSessionsImpl();
  const session: WorkoutSession = {
    id: `session-${now}`,
    createdAt: now,
    ...data,
    performedAt: data.performedAt ?? now,
  };
  await saveWorkoutSessionsImpl({ sessions: [...stored.sessions, session] });
  return session;
}
export async function appendAIInteractionImpl(
  data: Omit<AIInteraction, "id" | "createdAt" | "updatedAt" | "deletedAt">,
): Promise<AIInteraction> {
  const now = Date.now();
  const record: AIInteraction = {
    id: `ai-${now}`,
    createdAt: now,
    ...data,
  } as AIInteraction;
  const day = new Date(now).toISOString().slice(0, 10);
  const store = await getDomainStore();
  await store.log.append("ai-interactions", day, record);
  return record;
}

export async function appendVoiceTranscriptImpl(
  data: Omit<VoiceTranscript, "id" | "createdAt" | "updatedAt" | "deletedAt">,
): Promise<VoiceTranscript> {
  const now = Date.now();
  const record: VoiceTranscript = {
    id: `voice-${now}`,
    createdAt: now,
    ...data,
  } as VoiceTranscript;
  const day = new Date(now).toISOString().slice(0, 10);
  const store = await getDomainStore();
  await store.log.append("voice-transcripts", day, record);
  return record;
}
export async function loadExerciseLibraryImpl(): Promise<ExerciseLibrary | null> {
  const store = await getDomainStore();
  return store.ref.get<ExerciseLibrary>("exercise-library.json");
}

export async function saveExerciseLibraryImpl(lib: ExerciseLibrary): Promise<ExerciseLibrary> {
  const store = await getDomainStore();
  await store.ref.put("exercise-library.json", lib);
  return lib;
}

export {
  addMacros,
  emptyMacros,
  estimateMacrosFromText,
  loadDailyNutritionImpl,
  saveDailyNutritionImpl,
  sumMealMacros,
} from "@/server/nutrition-impl";
export type { DailyNutritionPayload } from "@/server/nutrition-impl";

export {
  appendTransactionImpl,
  loadBudgetImpl,
  loadCategoryRulesImpl,
  loadDailyFinanceImpl,
  loadLatestDailyFinanceImpl,
  loadSubscriptionsImpl,
  loadTransactionsImpl,
  saveBudgetImpl,
  saveDailyFinanceImpl,
  saveSubscriptionsImpl,
  updateCategoryRulesImpl,
  updateTransactionsImpl,
} from "@/server/finance-data-impl";
export type {
  BudgetPayload,
  CategoryRulesStore,
  DailyFinancePayload,
  SubscriptionsStore,
  TransactionsStore,
} from "@/server/finance-data-impl";

export {
  loadProductivityTasksForDayImpl,
  saveProductivityTasksForDayImpl,
} from "@/server/productivity-impl";
export type { ProductivityTasksPayload } from "@/server/productivity-impl";

export {
  loadDailyDashboardImpl,
  loadDailyFocusScoreImpl,
  loadDailyPlanImpl,
  loadWeeklyReviewImpl,
  saveDailyFocusScoreImpl,
  saveDailyPlanImpl,
  saveWeeklyReviewImpl,
} from "@/server/daily-dashboard-impl";
export type {
  DailyActivity,
  DailyDashboardPayload,
  DailyPlanPayload,
} from "@/server/daily-dashboard-impl";

export { executeVoiceIntentImpl, processVoiceInputImpl } from "@/server/voice-impl";
export type { VoiceProcessResult } from "@/server/voice-impl";

export {
  recordSoftDeletedKeyImpl,
  runHardDeleteMaintenanceImpl,
  softDeleteInStoreImpl,
} from "@/server/soft-delete-impl";
