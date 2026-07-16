import { useQueryClient } from "@tanstack/react-query";
import { estimateFoodMacros } from "@/server/coach";
import {
  addDailyWater,
  appendMealLog,
  appendWorkoutSession,
  removeMealLog,
  setDailyWater,
} from "@/server/domain";
import { flOzToMl, newId, type DailyNutrition, type ISODate, type MealLog } from "@/lib/domain";
import { queryKeys } from "@/lib/queries";

export function useHealthLogging(date: ISODate) {
  const queryClient = useQueryClient();

  async function refreshHealthQueries() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(date) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.nutrition(date) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.workoutSessions() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.weeklyWorkoutPlan(date) }),
    ]);
  }

  async function cacheNutrition(saved: DailyNutrition) {
    queryClient.setQueryData(queryKeys.nutrition(date), saved);
    await queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(date) });
    return saved;
  }

  async function addMeal(description: string, timestamp = Date.now()) {
    const estimate = await estimateFoodMacros({ data: { description: description.trim() } });
    const meal: MealLog = {
      id: newId("meal"),
      timestamp,
      foodItems: [
        {
          id: newId("food"),
          name: estimate.name,
          quantity: estimate.quantity,
          unit: estimate.unit,
          macros: {
            calories: estimate.calories,
            protein: estimate.protein,
            carbs: estimate.carbs,
            fat: estimate.fat,
          },
          source: "custom",
        },
      ],
      estimateConfidence: estimate.confidence,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const saved = await appendMealLog({ data: { date, meal } });
    await cacheNutrition(saved);
    return { saved, estimate, mealId: meal.id };
  }

  async function setWaterOz(totalOz: number) {
    return cacheNutrition(
      await setDailyWater({
        data: { date, waterMl: flOzToMl(Math.max(0, Math.round(totalOz))) ?? 0 },
      }),
    );
  }

  async function addWaterOz(amountOz: number) {
    const amountMl = flOzToMl(amountOz) ?? 0;
    const saved = await addDailyWater({ data: { date, amountMl } });
    await cacheNutrition(saved);
    return { saved, savedTotalMl: saved.waterMl ?? 0, increaseMl: amountMl };
  }

  async function removeMeal(mealId: string) {
    return cacheNutrition(await removeMealLog({ data: { date, mealId } }));
  }

  async function appendSimpleWorkout(input: {
    title: string;
    durationMinutes?: number;
    effortRating?: 1 | 2 | 3 | 4 | 5;
    performedAt?: number;
  }) {
    const session = await appendWorkoutSession({
      data: {
        performedAt: input.performedAt ?? Date.now(),
        notes: input.title.trim(),
        durationMinutes: input.durationMinutes,
        effortRating: input.effortRating,
        exercises: [],
      },
    });
    await refreshHealthQueries();
    return session;
  }

  return {
    addMeal,
    setWaterOz,
    addWaterOz,
    appendSimpleWorkout,
    removeMeal,
    refreshHealthQueries,
  };
}
