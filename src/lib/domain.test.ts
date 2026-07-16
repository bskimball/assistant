import { describe, expect, it } from "vitest";
import {
  addDaysISO,
  assertValidWorkoutSessionDate,
  dayBoundsLocal,
  formatISODate,
  isBillSubscription,
  isCuttableSubscription,
  isTimestampOnLocalDay,
  lastNDatesISO,
  loanPayoffMonths,
  mondayOfISO,
  recurringBudgetBucket,
  recurringKindOf,
  resolveVoiceTargetDate,
  timestampOnLocalDay,
  toISODate,
  weekDatesISO,
  type PerformedExercise,
} from "@/lib/domain";

describe("addDaysISO", () => {
  it("adds and subtracts whole days", () => {
    expect(addDaysISO("2026-07-01", 1)).toBe("2026-07-02");
    expect(addDaysISO("2026-07-01", -1)).toBe("2026-06-30");
    expect(addDaysISO("2026-07-01", 0)).toBe("2026-07-01");
  });

  it("crosses month and year boundaries", () => {
    expect(addDaysISO("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDaysISO("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysISO("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("is stable across US DST transitions", () => {
    // Spring forward (2026-03-08) and fall back (2026-11-01) in America/New_York.
    expect(addDaysISO("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDaysISO("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDaysISO("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysISO("2026-11-01", 1)).toBe("2026-11-02");
  });
});

describe("mondayOfISO / weekDatesISO", () => {
  it("returns Monday for mid-week and weekend anchors", () => {
    expect(mondayOfISO("2026-07-15")).toBe("2026-07-13"); // Wed
    expect(mondayOfISO("2026-07-13")).toBe("2026-07-13"); // Mon
    expect(mondayOfISO("2026-07-19")).toBe("2026-07-13"); // Sun
  });

  it("lists Mon→Sun", () => {
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
});

describe("lastNDatesISO", () => {
  it("returns oldest→newest trailing days", () => {
    expect(lastNDatesISO(3, "2026-07-15")).toEqual(["2026-07-13", "2026-07-14", "2026-07-15"]);
  });
});

describe("dayBoundsLocal / isTimestampOnLocalDay", () => {
  it("contains local midnight and excludes the next day", () => {
    const { start, end } = dayBoundsLocal("2026-07-15");
    expect(isTimestampOnLocalDay(start, "2026-07-15")).toBe(true);
    expect(isTimestampOnLocalDay(end, "2026-07-15")).toBe(true);
    expect(isTimestampOnLocalDay(end + 1, "2026-07-15")).toBe(false);
  });
});

describe("formatISODate / timestampOnLocalDay", () => {
  it("formats without throwing", () => {
    expect(formatISODate("2026-07-15")).toMatch(/15/);
  });

  it("uses now for today and pins wall clock on other days", () => {
    const now = new Date("2026-07-15T14:30:00").getTime();
    // When date is not todayISO(), pin to that local day at current clock.
    const pinned = timestampOnLocalDay("2020-01-02", now);
    const d = new Date(pinned);
    expect(d.getFullYear()).toBe(2020);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(2);
    expect(d.getHours()).toBe(new Date(now).getHours());
  });
});

describe("resolveVoiceTargetDate", () => {
  it("resolves tomorrow relative to the base date", () => {
    expect(resolveVoiceTargetDate("tomorrow", "2026-07-01")).toBe("2026-07-02");
    expect(resolveVoiceTargetDate("tomorrow", "2026-06-30")).toBe("2026-07-01");
  });

  it("resolves yesterday relative to the base date", () => {
    expect(resolveVoiceTargetDate("yesterday", "2026-07-01")).toBe("2026-06-30");
    expect(resolveVoiceTargetDate("yesterday", "2026-07-01".slice(0, 10))).toBe("2026-06-30");
    expect(resolveVoiceTargetDate("Yesterday", "2026-01-01")).toBe("2025-12-31");
  });

  it("passes through explicit ISO dates and defaults to base", () => {
    expect(resolveVoiceTargetDate("2026-08-15", "2026-07-01")).toBe("2026-08-15");
    expect(resolveVoiceTargetDate("today", "2026-07-01")).toBe("2026-07-01");
    expect(resolveVoiceTargetDate(undefined, "2026-07-01")).toBe("2026-07-01");
  });
});

describe("toISODate", () => {
  it("returns a YYYY-MM-DD day key", () => {
    expect(toISODate(new Date())).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("workout execution fields", () => {
  it("permits optional actual performance fields and retains a substitution plan name", () => {
    const exercise: PerformedExercise = {
      name: "Goblet Squat",
      plannedName: "Back Squat",
      actualSets: 3,
      actualReps: 10,
      actualWeightLb: 50,
      rpe: 8,
    };

    expect(exercise).toMatchObject({
      name: "Goblet Squat",
      plannedName: "Back Squat",
      actualSets: 3,
      actualReps: 10,
      actualWeightLb: 50,
      rpe: 8,
    });
  });

  it("rejects future workout sessions", () => {
    expect(() => assertValidWorkoutSessionDate(101, 100)).toThrow(
      "WorkoutSession.performedAt cannot be in the future",
    );
  });
});

describe("recurringKindOf / isBillSubscription", () => {
  it("uses an explicit kind when set", () => {
    expect(recurringKindOf({ kind: "loan", group: "wants" })).toBe("loan");
    expect(recurringKindOf({ kind: "subscription", group: "needs" })).toBe("subscription");
  });

  it("infers kind from the legacy group when kind is unset", () => {
    expect(recurringKindOf({ group: "needs" })).toBe("bill");
    expect(recurringKindOf({ group: "wants" })).toBe("subscription");
    expect(recurringKindOf({})).toBe("subscription");
  });

  it("treats loans and bills as recurring obligations, subscriptions as not", () => {
    expect(isBillSubscription({ kind: "loan" })).toBe(true);
    expect(isBillSubscription({ kind: "bill" })).toBe(true);
    expect(isBillSubscription({ kind: "subscription" })).toBe(false);
    expect(isBillSubscription({ group: "needs" })).toBe(true);
    expect(isBillSubscription({ group: "wants" })).toBe(false);
  });

  it("maps recurring commitments to the right budget bucket", () => {
    expect(recurringBudgetBucket({ kind: "loan", group: "wants" })).toBe("needs");
    expect(recurringBudgetBucket({ kind: "bill", group: "needs" })).toBe("needs");
    expect(recurringBudgetBucket({ kind: "bill", group: "wants" })).toBe("wants");
    expect(recurringBudgetBucket({ kind: "bill", group: "savings" })).toBe("needs");
    expect(recurringBudgetBucket({ kind: "subscription", group: "savings" })).toBe("savings");
    expect(recurringBudgetBucket({ kind: "subscription", group: "wants" })).toBe("wants");
    expect(recurringBudgetBucket({})).toBe("wants");
  });

  it("separates cuttable subscriptions from recurring savings", () => {
    expect(isCuttableSubscription({ kind: "subscription", group: "wants" })).toBe(true);
    expect(isCuttableSubscription({ kind: "subscription", group: "savings" })).toBe(false);
    expect(isCuttableSubscription({ kind: "bill" })).toBe(false);
    expect(isCuttableSubscription({ kind: "loan" })).toBe(false);
  });
});

describe("loanPayoffMonths", () => {
  it("returns null without enough information", () => {
    expect(loanPayoffMonths(undefined, 6, 1000)).toBeNull();
    expect(loanPayoffMonths(10000, 6, 0)).toBeNull();
  });

  it("divides evenly when there is no interest", () => {
    expect(loanPayoffMonths(12000, 0, 1000)).toBe(12);
    expect(loanPayoffMonths(12000, undefined, 500)).toBe(24);
  });

  it("amortizes with interest", () => {
    // $10k at 12% APR (1%/mo) paying $500/mo: 22.4 months → rounds up to 23.
    expect(loanPayoffMonths(10000, 12, 500)).toBe(23);
  });

  it("returns null when the payment can't cover the interest", () => {
    // $100k at 12% APR accrues $1,000/mo interest; a $500 payment never wins.
    expect(loanPayoffMonths(100000, 12, 500)).toBeNull();
  });
});
