import type {
  AIInteraction,
  DailyFocusScore,
  DailyPlan,
  ISODate,
  ISOWeek,
  VoiceTranscript,
  WeeklyReview,
} from "@/lib/domain";
import { loadDailyFinanceImpl, type DailyFinancePayload } from "@/server/finance-data-impl";
import { loadDailyNutritionImpl, type DailyNutritionPayload } from "@/server/nutrition-impl";
import {
  loadProductivityTasksForDayImpl,
  type ProductivityTasksPayload,
} from "@/server/productivity-impl";
import { getDomainStore } from "@/server/store";

export type DailyPlanPayload = DailyPlan & { updatedAt: number };

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

export async function loadDailyPlanImpl(date: ISODate): Promise<DailyPlanPayload | null> {
  const store = await getDomainStore();
  return store.daily.get<DailyPlanPayload>("daily-plan", date);
}

export async function saveDailyPlanImpl(plan: DailyPlan): Promise<DailyPlanPayload> {
  const payload: DailyPlanPayload = { ...plan, updatedAt: Date.now() };
  const store = await getDomainStore();
  await store.daily.put("daily-plan", plan.date, payload);
  return payload;
}

export async function loadDailyFocusScoreImpl(
  date: ISODate,
): Promise<(DailyFocusScore & { updatedAt: number }) | null> {
  const store = await getDomainStore();
  return store.daily.get<DailyFocusScore & { updatedAt: number }>("focus-score", date);
}

export async function saveDailyFocusScoreImpl(
  score: DailyFocusScore,
): Promise<DailyFocusScore & { updatedAt: number }> {
  const payload = { ...score, updatedAt: Date.now() };
  const store = await getDomainStore();
  await store.daily.put("focus-score", score.date, payload);
  return payload;
}

export async function loadWeeklyReviewImpl(
  week: ISOWeek,
): Promise<(WeeklyReview & { updatedAt: number }) | null> {
  const store = await getDomainStore();
  return store.weekly.get<WeeklyReview & { updatedAt: number }>("weekly-review", week);
}

export async function saveWeeklyReviewImpl(
  review: WeeklyReview,
): Promise<WeeklyReview & { updatedAt: number }> {
  const payload = { ...review, updatedAt: Date.now() };
  const store = await getDomainStore();
  await store.weekly.put("weekly-review", review.week, payload);
  return payload;
}

export async function loadDailyDashboardImpl(date: ISODate): Promise<DailyDashboardPayload> {
  const store = await getDomainStore();
  const [nutrition, finance, productivity, plan, focus, ai, voice] = await Promise.all([
    loadDailyNutritionImpl(date),
    loadDailyFinanceImpl(date),
    loadProductivityTasksForDayImpl(date),
    loadDailyPlanImpl(date),
    loadDailyFocusScoreImpl(date),
    store.log.read<AIInteraction>("ai-interactions", date),
    store.log.read<VoiceTranscript>("voice-transcripts", date),
  ]);
  const dayStart = new Date(date + "T00:00:00").getTime();
  const dayEnd = new Date(date + "T23:59:59.999").getTime();
  return {
    date,
    nutrition,
    finance,
    productivity,
    plan,
    focus,
    recent: {
      interactions: ai.filter((i) => i.timestamp >= dayStart && i.timestamp <= dayEnd),
      transcripts: voice.filter((t) => t.timestamp >= dayStart && t.timestamp <= dayEnd),
    },
  };
}
