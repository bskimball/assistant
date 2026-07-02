import { describe, expect, it } from "vitest";
import { addDaysISO, resolveVoiceTargetDate, toISODate } from "@/lib/domain";

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

describe("resolveVoiceTargetDate", () => {
  it("resolves tomorrow relative to the base date", () => {
    expect(resolveVoiceTargetDate("tomorrow", "2026-07-01")).toBe("2026-07-02");
    expect(resolveVoiceTargetDate("tomorrow", "2026-06-30")).toBe("2026-07-01");
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
