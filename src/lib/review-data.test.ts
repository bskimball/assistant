import { describe, expect, it } from "vitest";
import { dayBoundsLocal, lastNDatesISO, weekDatesISO, type ISODate } from "@/lib/domain";
import { reduceAnalyticsData, reduceWeeklyData, type ReviewDashboard } from "@/lib/review-data";

function dashboard(overrides: ReviewDashboard = {}): ReviewDashboard {
  return {
    productivity: { tasks: [] },
    nutrition: {
      mealLogs: [],
      totals: { calories: 0, protein: 0, carbs: 0, fat: 0 },
      waterMl: 0,
    },
    finance: { netWorth: 0 },
    plan: null,
    recent: { transcripts: [] },
    ...overrides,
  };
}

describe("review date windows", () => {
  it("builds a Monday through Sunday week", () => {
    expect(weekDatesISO("2026-07-15")).toEqual([
      "2026-07-13",
      "2026-07-14",
      "2026-07-15",
      "2026-07-16",
      "2026-07-17",
      "2026-07-18",
      "2026-07-19",
    ]);
  });

  it("builds trailing dates oldest to newest", () => {
    expect(lastNDatesISO(3, "2026-07-15")).toEqual(["2026-07-13", "2026-07-14", "2026-07-15"]);
  });
});

describe("reduceWeeklyData", () => {
  it("counts workouts inside the local Mon-Sun bounds only", () => {
    const dates = weekDatesISO("2026-07-15");
    const monday = dayBoundsLocal(dates[0]);
    const sunday = dayBoundsLocal(dates[6]);
    const stats = reduceWeeklyData(
      dates,
      dates.map(() => dashboard()),
      [
        { performedAt: monday.start },
        { performedAt: sunday.end },
        { performedAt: monday.start - 1 },
        { performedAt: sunday.end + 1 },
        { performedAt: monday.start + 1, deletedAt: monday.start + 2 },
      ],
    );

    expect(stats.workouts).toBe(2);
  });
});

describe("reduceAnalyticsData", () => {
  it("reduces dashboard metrics and excludes transfers from cashflow", () => {
    const date: ISODate = "2026-07-15";
    const bounds = dayBoundsLocal(date);
    const points = reduceAnalyticsData(
      [date],
      [
        dashboard({
          productivity: {
            tasks: [
              { id: "done", createdAt: 1, text: "Done", status: "done", done: true, date },
              {
                id: "open",
                createdAt: 2,
                text: "Open",
                status: "pending",
                done: false,
                date,
              },
            ],
          },
          nutrition: {
            mealLogs: [],
            totals: { calories: 500, protein: 75, carbs: 50, fat: 20 },
            waterMl: 591,
          },
          finance: { netWorth: 1234 },
          plan: { nutritionTargets: { protein: 150 } },
        }),
      ],
      [{ performedAt: bounds.start }, { performedAt: bounds.end + 1 }],
      [
        { timestamp: bounds.start, amount: 100, categoryGroup: "income" },
        { timestamp: bounds.start + 1, amount: -25, categoryGroup: "wants" },
        { timestamp: bounds.start + 2, amount: -40, categoryGroup: "transfer" },
        { timestamp: bounds.end + 1, amount: 500, categoryGroup: "income" },
      ],
    );

    expect(points).toEqual([
      {
        date,
        completionPct: 50,
        tasksTotal: 2,
        proteinPct: 50,
        waterOz: 20,
        netWorth: 1234,
        workouts: 1,
        cashflow: 75,
      },
    ]);
  });
});
