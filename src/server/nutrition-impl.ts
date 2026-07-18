import type { DailyNutrition, ISODate, MealLog } from "@/lib/domain";
import { assertValidMealLog, type Macros } from "@/lib/domain";
import { getDomainStore } from "@/server/store";

export type DailyNutritionPayload = DailyNutrition & { updatedAt: number };

export function emptyMacros(): Macros {
  return { calories: 0, protein: 0, carbs: 0, fat: 0 };
}

export function addMacros(a: Macros, b: Partial<Macros>): Macros {
  return {
    calories: Math.max(0, Math.round(a.calories + (b.calories ?? 0))),
    protein: Math.max(0, Math.round(a.protein + (b.protein ?? 0))),
    carbs: Math.max(0, Math.round(a.carbs + (b.carbs ?? 0))),
    fat: Math.max(0, Math.round(a.fat + (b.fat ?? 0))),
  };
}

export function sumMealMacros(meals: DailyNutrition["mealLogs"]): Macros {
  return meals
    .filter((meal) => !meal.deletedAt)
    .flatMap((meal) => meal.foodItems || [])
    .reduce((total, item) => addMacros(total, item.macros || emptyMacros()), emptyMacros());
}

function inferFoodMacrosFromText(
  lower: string,
): { macros: Macros; confidence: "low" | "medium" } | null {
  if (/\b0\s*(?:cal|cals|calorie|calories|kcal)\b/.test(lower)) {
    return { macros: emptyMacros(), confidence: "medium" };
  }

  const simpleZeroCalorieDrink =
    /^\s*(?:(?:\d+(?:\.\d+)?)\s*(?:fl\s*)?oz\s+(?:of\s+)?)?(?:plain\s+)?(?:water|black coffee|unsweetened tea|diet soda)\s*[.!]?\s*$/.test(
      lower,
    );
  if (simpleZeroCalorieDrink) {
    return { macros: emptyMacros(), confidence: "medium" };
  }

  return null;
}

export function estimateMacrosFromText(text: string): {
  macros: Macros;
  confidence: "low" | "medium" | "high";
} {
  const lower = text.toLowerCase();
  const read = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = lower.match(pattern);
      if (match?.[1]) return Number(match[1]);
    }
    return 0;
  };
  const protein = read([
    /(\d+(?:\.\d+)?)\s*g(?:rams?)?\s*(?:of\s*)?protein/,
    /protein\s*(\d+(?:\.\d+)?)\s*g?/,
  ]);
  const carbs = read([
    /(\d+(?:\.\d+)?)\s*g(?:rams?)?\s*(?:of\s*)?carbs?/,
    /carbs?\s*(\d+(?:\.\d+)?)\s*g?/,
  ]);
  const fat = read([/(\d+(?:\.\d+)?)\s*g(?:rams?)?\s*(?:of\s*)?fat/, /fat\s*(\d+(?:\.\d+)?)\s*g?/]);
  const calories = read([
    /(\d+(?:\.\d+)?)\s*(?:cal|cals|calories|kcal)/,
    /(?:cal|cals|calories|kcal)\s*(\d+(?:\.\d+)?)/,
  ]);
  const macroCalories = protein * 4 + carbs * 4 + fat * 9;
  const inferredCalories = calories || macroCalories;
  const knownCount = [protein, carbs, fat, calories].filter((n) => n > 0).length;
  if (knownCount === 0) {
    const inferred = inferFoodMacrosFromText(lower);
    if (inferred) return inferred;
  }
  return {
    macros: {
      calories: Math.round(inferredCalories),
      protein: Math.round(protein),
      carbs: Math.round(carbs),
      fat: Math.round(fat),
    },
    confidence: knownCount >= 3 ? "high" : knownCount >= 1 ? "medium" : "low",
  };
}

export async function loadDailyNutritionImpl(date: ISODate): Promise<DailyNutritionPayload> {
  const store = await getDomainStore();
  const stored = await store.daily.get<DailyNutritionPayload>("daily-nutrition", date);
  if (stored) return stored;
  return {
    id: `nutrition-${date}`,
    date,
    mealLogs: [],
    totals: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export async function saveDailyNutritionImpl(data: {
  date: ISODate;
  nutrition: Omit<DailyNutrition, "id" | "createdAt" | "updatedAt" | "deletedAt" | "date">;
}): Promise<DailyNutritionPayload> {
  data.nutrition.mealLogs.forEach(assertValidMealLog);
  return updateDailyNutrition(data.date, (current) => {
    const currentMealIds = new Set(current.mealLogs.map((meal) => meal.id));
    const incomingMeals = new Map(data.nutrition.mealLogs.map((meal) => [meal.id, meal]));
    return {
      ...current,
      ...data.nutrition,
      mealLogs: [
        ...current.mealLogs.map((meal) => incomingMeals.get(meal.id) ?? meal),
        ...data.nutrition.mealLogs.filter((meal) => !currentMealIds.has(meal.id)),
      ],
    };
  });
}

function emptyDailyNutrition(date: ISODate, now: number): DailyNutritionPayload {
  return {
    id: `nutrition-${date}`,
    date,
    mealLogs: [],
    totals: emptyMacros(),
    createdAt: now,
    updatedAt: now,
  };
}

async function updateDailyNutrition(
  date: ISODate,
  mutate: (current: DailyNutritionPayload) => DailyNutritionPayload,
): Promise<DailyNutritionPayload> {
  const store = await getDomainStore();
  return store.daily.update<DailyNutritionPayload>("daily-nutrition", date, (stored) => {
    const now = Date.now();
    const next = mutate(stored ?? emptyDailyNutrition(date, now));
    return { ...next, totals: sumMealMacros(next.mealLogs), updatedAt: now };
  });
}

export async function appendMealLogImpl(data: {
  date: ISODate;
  meal: MealLog;
}): Promise<DailyNutritionPayload> {
  assertValidMealLog(data.meal);
  return updateDailyNutrition(data.date, (current) => ({
    ...current,
    mealLogs: current.mealLogs.some((meal) => meal.id === data.meal.id)
      ? current.mealLogs
      : [...current.mealLogs, data.meal],
  }));
}

export async function setDailyWaterImpl(data: {
  date: ISODate;
  waterMl: number;
}): Promise<DailyNutritionPayload> {
  if (!Number.isFinite(data.waterMl) || data.waterMl < 0)
    throw new Error("Valid water total is required");
  return updateDailyNutrition(data.date, (current) => ({
    ...current,
    waterMl: Math.round(data.waterMl),
  }));
}

export async function addDailyWaterImpl(data: {
  date: ISODate;
  amountMl: number;
}): Promise<DailyNutritionPayload> {
  if (!Number.isFinite(data.amountMl) || data.amountMl <= 0)
    throw new Error("Valid water amount is required");
  return updateDailyNutrition(data.date, (current) => ({
    ...current,
    waterMl: Math.max(0, Math.round((current.waterMl ?? 0) + data.amountMl)),
  }));
}

export async function removeMealLogImpl(data: {
  date: ISODate;
  mealId: string;
}): Promise<DailyNutritionPayload> {
  const mealId = data.mealId.trim();
  if (!mealId) throw new Error("Meal id is required");
  return updateDailyNutrition(data.date, (current) => ({
    ...current,
    mealLogs: current.mealLogs.filter((meal) => meal.id !== mealId),
  }));
}
