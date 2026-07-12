import { describe, expect, it } from "vitest";
import type { RecommendationOutcome } from "@/lib/domain";
import {
  isAvoidedRecommendation,
  recommendationLearningBlock,
  summarizeRecommendationLearning,
} from "@/lib/recommendation-learning";

function outcome(
  overrides: Partial<RecommendationOutcome> & Pick<RecommendationOutcome, "id">,
): RecommendationOutcome {
  return {
    date: "2026-07-12",
    source: "coach-daily",
    text: "Take a walk",
    status: "accepted",
    recordedAt: 1,
    ...overrides,
  };
}

describe("summarizeRecommendationLearning", () => {
  it("keeps the newest event per id and groups by feedback", () => {
    const learning = summarizeRecommendationLearning([
      outcome({ id: "walk", status: "accepted", recordedAt: 1 }),
      outcome({ id: "walk", status: "completed", helpful: true, recordedAt: 2 }),
      outcome({
        id: "protein",
        text: "Close the protein gap",
        status: "dismissed",
        recordedAt: 3,
      }),
      outcome({
        id: "hydrate",
        text: "Drink more water",
        status: "snoozed",
        helpful: false,
        recordedAt: 4,
      }),
    ]);

    expect(learning.latest).toHaveLength(3);
    expect(learning.completedTexts).toEqual(["Take a walk"]);
    expect(learning.helpfulTexts).toEqual(["Take a walk"]);
    expect(learning.dismissedTexts).toEqual(["Close the protein gap"]);
    expect(learning.snoozedTexts).toEqual(["Drink more water"]);
    expect(learning.notHelpfulTexts).toEqual(["Drink more water"]);
  });
});

describe("isAvoidedRecommendation", () => {
  it("matches exact and contained prior feedback", () => {
    const learning = {
      dismissedTexts: ["Review the household spending guardrail carefully"],
      notHelpfulTexts: ["Generic side hustle idea"],
    };
    expect(
      isAvoidedRecommendation("Review the household spending guardrail carefully", learning),
    ).toBe(true);
    expect(isAvoidedRecommendation("Generic side hustle idea for freelancers", learning)).toBe(
      true,
    );
    expect(isAvoidedRecommendation("Do a short walk after lunch", learning)).toBe(false);
  });
});

describe("recommendationLearningBlock", () => {
  it("returns empty when there is no signal", () => {
    expect(
      recommendationLearningBlock({
        latest: [],
        completedTexts: [],
        helpfulTexts: [],
        notHelpfulTexts: [],
        dismissedTexts: [],
        snoozedTexts: [],
      }),
    ).toBe("");
  });

  it("renders helpful and avoid lists", () => {
    const block = recommendationLearningBlock({
      latest: [],
      completedTexts: ["Finish the report"],
      helpfulTexts: ["Finish the report"],
      notHelpfulTexts: ["Cold outreach spam"],
      dismissedTexts: [],
      snoozedTexts: ["Meal prep marathon"],
    });
    expect(block).toContain("Helpful recently");
    expect(block).toContain("NOT helpful");
    expect(block).toContain("Snoozed");
    expect(block).toContain("Finish the report");
  });
});
