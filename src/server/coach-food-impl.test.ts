import { beforeEach, describe, expect, it, vi } from "vitest";

const ai = vi.hoisted(() => ({
  apiKey: undefined as string | undefined,
  result: undefined as Record<string, unknown> | undefined,
}));
vi.mock("@/server/adapters/ai", () => ({
  getGrokApiKey: vi.fn(async () => ai.apiKey),
  getGrokJsonModel: vi.fn(async () => "grok-test"),
  completeJSON: vi.fn(async () => ai.result),
}));

import { completeJSON } from "@/server/adapters/ai";
import { estimateFoodMacrosImpl } from "@/server/coach-food-impl";

describe("estimateFoodMacrosImpl deterministic fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ai.apiKey = undefined;
    ai.result = undefined;
  });

  it.each(["oatmeal creme pie", "oatmeal cream pie"])(
    "uses the AI estimator for %s rather than a food-specific fallback",
    async (description) => {
      ai.apiKey = "test-key";
      ai.result = {
        name: "Oatmeal creme pie",
        quantity: 1,
        unit: "piece",
        calories: 170,
        protein: 1,
        carbs: 26,
        fat: 7,
        confidence: "medium",
      };

      const estimate = await estimateFoodMacrosImpl({ description });

      expect(estimate).toMatchObject({
        calories: 170,
        generatedBy: "ai",
      });
    },
  );

  it("does not invent food nutrition when AI is unavailable", async () => {
    const estimate = await estimateFoodMacrosImpl({
      description: "oatmeal creme pie",
    });

    expect(estimate).toMatchObject({
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      confidence: "low",
      generatedBy: "fallback",
    });
  });

  it("preserves an explicit zero-calorie drink", async () => {
    const estimate = await estimateFoodMacrosImpl({
      description: "0 calorie soda",
    });

    expect(estimate).toMatchObject({
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      confidence: "medium",
      generatedBy: "fallback",
    });
  });

  it("keeps explicit nutrition without calling the AI estimator", async () => {
    ai.apiKey = "test-key";
    ai.result = {
      name: "Wrong replacement",
      calories: 1,
      protein: 0,
      carbs: 0,
      fat: 0,
    };

    const estimate = await estimateFoodMacrosImpl({
      description: "oatmeal creme pie, 300 calories and 4g protein",
    });

    expect(estimate).toMatchObject({
      calories: 300,
      protein: 4,
      generatedBy: "fallback",
    });
    expect(completeJSON).not.toHaveBeenCalled();
  });

  it("does not treat a mixed meal containing a zero-calorie drink as all zero", async () => {
    const estimate = await estimateFoodMacrosImpl({
      description: "diet soda and a burger",
    });

    expect(estimate.confidence).toBe("low");
  });
});
