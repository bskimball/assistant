import { describe, expect, it } from "vitest";
import type { RecommendationOutcome } from "@/lib/domain";
import { buildEffectivenessReport } from "@/lib/effectiveness-report";

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

describe("buildEffectivenessReport", () => {
  it("returns an empty, source-complete report", () => {
    expect(buildEffectivenessReport([], "2026-07")).toEqual({
      month: "2026-07",
      total: 0,
      accepted: 0,
      completed: 0,
      dismissed: 0,
      snoozed: 0,
      helpfulYes: 0,
      helpfulNo: 0,
      completionRate: 0,
      bySource: {
        "coach-daily": {
          total: 0,
          accepted: 0,
          completed: 0,
          dismissed: 0,
          snoozed: 0,
          helpfulYes: 0,
          helpfulNo: 0,
          completionRate: 0,
        },
        "coach-weekly": {
          total: 0,
          accepted: 0,
          completed: 0,
          dismissed: 0,
          snoozed: 0,
          helpfulYes: 0,
          helpfulNo: 0,
          completionRate: 0,
        },
        "next-best-action": {
          total: 0,
          accepted: 0,
          completed: 0,
          dismissed: 0,
          snoozed: 0,
          helpfulYes: 0,
          helpfulNo: 0,
          completionRate: 0,
        },
      },
      topCompleted: [],
    });
  });

  it("keeps only the newest event for each recommendation and calculates rates", () => {
    const report = buildEffectivenessReport(
      [
        outcome({ id: "walk", status: "accepted", recordedAt: 1 }),
        outcome({ id: "walk", status: "completed", helpful: true, recordedAt: 2 }),
        outcome({
          id: "weekly",
          source: "coach-weekly",
          text: "Plan meals",
          status: "accepted",
          helpful: false,
          recordedAt: 3,
        }),
        outcome({
          id: "dismissed",
          source: "next-best-action",
          text: "Review spending",
          status: "dismissed",
          recordedAt: 4,
        }),
        outcome({
          id: "later",
          source: "next-best-action",
          text: "Stretch for five minutes",
          status: "snoozed",
          recordedAt: 4.5,
        }),
        outcome({ id: "outside-month", date: "2026-08-01", status: "completed", recordedAt: 5 }),
      ],
      "2026-07",
    );

    expect(report).toMatchObject({
      total: 4,
      accepted: 1,
      completed: 1,
      dismissed: 1,
      snoozed: 1,
      helpfulYes: 1,
      helpfulNo: 1,
      completionRate: 0.5,
      topCompleted: ["Take a walk"],
    });
    expect(report.bySource["coach-daily"]).toMatchObject({
      total: 1,
      completed: 1,
      helpfulYes: 1,
      completionRate: 1,
    });
    expect(report.bySource["coach-weekly"]).toMatchObject({
      total: 1,
      accepted: 1,
      helpfulNo: 1,
      completionRate: 0,
    });
  });

  it("returns up to five most-recent completed action texts", () => {
    const outcomes = Array.from({ length: 6 }, (_, index) =>
      outcome({
        id: `completed-${index}`,
        text: `Action ${index}`,
        status: "completed",
        recordedAt: index,
      }),
    );

    expect(buildEffectivenessReport(outcomes, "2026-07").topCompleted).toEqual([
      "Action 5",
      "Action 4",
      "Action 3",
      "Action 2",
      "Action 1",
    ]);
  });
});
