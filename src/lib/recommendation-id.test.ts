import { describe, expect, it } from "vitest";
import { stableRecommendationId } from "@/lib/recommendation-id";

describe("stableRecommendationId", () => {
  it("returns the same ID for the same recommendation", () => {
    expect(stableRecommendationId("2026-07-12", "coach-daily", "Take a 10-minute walk")).toBe(
      stableRecommendationId("2026-07-12", "coach-daily", "Take a 10-minute walk"),
    );
  });

  it("distinguishes recommendation text, date, and source", () => {
    const base = stableRecommendationId("2026-07-12", "coach-daily", "Take a 10-minute walk");

    expect(stableRecommendationId("2026-07-12", "coach-daily", "Drink water")).not.toBe(base);
    expect(stableRecommendationId("2026-07-13", "coach-daily", "Take a 10-minute walk")).not.toBe(
      base,
    );
    expect(
      stableRecommendationId("2026-07-12", "next-best-action", "Take a 10-minute walk"),
    ).not.toBe(base);
  });

  it("normalizes whitespace and case", () => {
    expect(
      stableRecommendationId(" 2026-07-12 ", " COACH-DAILY ", "  Take   A 10-minute WALK "),
    ).toBe(stableRecommendationId("2026-07-12", "coach-daily", "take a 10-minute walk"));
  });
});
