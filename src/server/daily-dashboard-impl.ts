import type {
  AIInteraction,
  DailyFocusScore,
  DailyPlan,
  EveningCheckIn,
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

export async function saveEveningCheckInImpl(data: {
  date: ISODate;
  checkIn: EveningCheckIn;
}): Promise<DailyPlanPayload> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new Error("Valid date is required");
  const { energy, dayRating, completedAt } = data.checkIn;
  if (![energy, dayRating].every((value) => Number.isInteger(value) && value >= 1 && value <= 5))
    throw new Error("Energy and day rating must be whole numbers from 1 to 5");
  if (!Number.isFinite(completedAt) || completedAt <= 0 || completedAt > Date.now() + 60_000)
    throw new Error("Invalid check-in timestamp");
  for (const text of [data.checkIn.win, data.checkIn.friction, data.checkIn.note]) {
    if (text && text.length > 1000)
      throw new Error("Check-in text must be 1000 characters or less");
  }

  const now = Date.now();
  const store = await getDomainStore();
  return store.daily.update<DailyPlanPayload>("daily-plan", data.date, (current) => ({
    ...(current ?? { id: `daily-plan-${data.date}`, createdAt: now, date: data.date }),
    date: data.date,
    topTaskIds: current?.topTaskIds ?? [],
    eveningCheckIn: data.checkIn,
    updatedAt: now,
  }));
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
