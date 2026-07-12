import { describe, expect, it } from "vitest";
import { selectNextBestAction } from "@/lib/next-best-action";

describe("selectNextBestAction", () => {
  it("prioritizes the top unfinished task", () => {
    expect(
      selectNextBestAction({
        incompleteTopTask: { title: "Submit the report", overdue: true },
        plannedWorkoutIncomplete: true,
      }),
    ).toMatchObject({ domain: "focus", title: "Submit the report", href: "/kanban" });
  });

  it("offers workout variants when the planned session is open", () => {
    expect(selectNextBestAction({ plannedWorkoutIncomplete: true })).toMatchObject({
      domain: "fitness",
      href: "/workouts",
    });
  });

  it("uses late-day protein before hydration and finance", () => {
    expect(
      selectNextBestAction({ hourLocal: 18, proteinPct: 60, waterPct: 40, financeStatus: "tight" }),
    ).toMatchObject({ domain: "nutrition", title: "Close today’s protein gap" });
  });

  it("falls back deterministically", () => {
    expect(selectNextBestAction({})).toMatchObject({ domain: "general", href: "/weekly" });
  });

  it("surfaces an overdue reason when the top task is past due", () => {
    expect(
      selectNextBestAction({
        incompleteTopTask: { title: "Pay the bill", overdue: true },
      }).reason,
    ).toMatch(/overdue/i);
  });
});
