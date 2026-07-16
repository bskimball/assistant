import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyNutrition, MealLog } from "@/lib/domain";

const state = vi.hoisted(() => ({ current: null as DailyNutrition | null }));
vi.mock("@/server/store", () => ({
  getDomainStore: vi.fn(async () => ({
    daily: {
      update: vi.fn(
        async (
          _domain: string,
          _date: string,
          mutate: (value: DailyNutrition | null) => DailyNutrition,
        ) => {
          state.current = mutate(state.current);
          return state.current;
        },
      ),
    },
  })),
}));

import {
  addDailyWaterImpl,
  appendMealLogImpl,
  removeMealLogImpl,
  saveDailyNutritionImpl,
} from "@/server/nutrition-impl";

function meal(id: string, protein: number): MealLog {
  return {
    id,
    createdAt: 1,
    timestamp: 1,
    foodItems: [
      {
        id: `food-${id}`,
        name: id,
        quantity: 1,
        unit: "serving",
        source: "custom",
        macros: { calories: 100, protein, carbs: 5, fat: 2 },
      },
    ],
  };
}

describe("atomic nutrition mutations", () => {
  beforeEach(() => {
    state.current = null;
  });

  it("preserves concurrent fields across meal and water mutations", async () => {
    await appendMealLogImpl({ date: "2026-07-15", meal: meal("a", 20) });
    await addDailyWaterImpl({ date: "2026-07-15", amountMl: 355 });
    await appendMealLogImpl({ date: "2026-07-15", meal: meal("b", 30) });
    expect(state.current).toMatchObject({ waterMl: 355, totals: { protein: 50 } });
    expect(state.current?.mealLogs.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("merges a stale whole-day save without dropping interleaved meals or water", async () => {
    await appendMealLogImpl({ date: "2026-07-15", meal: meal("a", 20) });
    const staleMealLogs = [...(state.current?.mealLogs ?? [])];

    await appendMealLogImpl({ date: "2026-07-15", meal: meal("b", 30) });
    await addDailyWaterImpl({ date: "2026-07-15", amountMl: 355 });
    await saveDailyNutritionImpl({
      date: "2026-07-15",
      nutrition: {
        mealLogs: staleMealLogs,
        totals: { calories: 0, protein: 0, carbs: 0, fat: 0 },
        waterMl: 500,
      },
    });

    expect(state.current).toMatchObject({ waterMl: 500, totals: { protein: 50 } });
    expect(state.current?.mealLogs.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("removes only the requested meal while preserving water", async () => {
    state.current = {
      id: "nutrition-2026-07-15",
      date: "2026-07-15",
      createdAt: 1,
      mealLogs: [meal("a", 20), meal("b", 30)],
      totals: { calories: 200, protein: 50, carbs: 10, fat: 4 },
      waterMl: 500,
    };
    await removeMealLogImpl({ date: "2026-07-15", mealId: "a" });
    expect(state.current).toMatchObject({ waterMl: 500, totals: { protein: 30 } });
    expect(state.current?.mealLogs.map((item) => item.id)).toEqual(["b"]);
  });
});
