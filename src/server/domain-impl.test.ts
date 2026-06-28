import { describe, expect, it } from "vitest";
import { estimateMacrosFromText } from "./domain-impl";

describe("estimateMacrosFromText", () => {
  it("keeps explicit calorie entries exact", () => {
    const estimate = estimateMacrosFromText("600 calorie lunch");

    expect(estimate.macros.calories).toBe(600);
    expect(estimate.macros.protein).toBe(0);
    expect(estimate.confidence).toBe("medium");
  });

  it("infers calories from explicit macros", () => {
    const estimate = estimateMacrosFromText("40g protein 50g carbs 20g fat meal");

    expect(estimate.macros.calories).toBe(540);
    expect(estimate.macros.protein).toBe(40);
    expect(estimate.macros.carbs).toBe(50);
    expect(estimate.macros.fat).toBe(20);
    expect(estimate.confidence).toBe("high");
  });

  it("does not invent calories for food text without explicit numbers", () => {
    const estimate = estimateMacrosFromText("homemade casserole");

    expect(estimate.macros.calories).toBe(0);
    expect(estimate.macros.protein).toBe(0);
    expect(estimate.confidence).toBe("low");
  });

  it("keeps explicit zero-calorie drinks at zero", () => {
    const estimate = estimateMacrosFromText("0 calorie soda");

    expect(estimate.macros.calories).toBe(0);
    expect(estimate.macros.protein).toBe(0);
    expect(estimate.confidence).toBe("medium");
  });
});
