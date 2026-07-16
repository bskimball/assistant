import { describe, expect, it } from "vitest";
import { dateHashIndex, fallbackDailyQuote, FALLBACK_QUOTES } from "@/server/daily-quote-impl";

describe("dateHashIndex", () => {
  it("is stable for the same date", () => {
    expect(dateHashIndex("2026-07-16", 12)).toBe(dateHashIndex("2026-07-16", 12));
  });

  it("stays in range", () => {
    for (const d of ["2026-01-01", "2026-07-16", "2026-12-31"]) {
      const i = dateHashIndex(d, FALLBACK_QUOTES.length);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(FALLBACK_QUOTES.length);
    }
  });

  it("varies across different dates (not all identical)", () => {
    const indexes = new Set(
      ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-10", "2026-08-01"].map((d) =>
        dateHashIndex(d, FALLBACK_QUOTES.length),
      ),
    );
    expect(indexes.size).toBeGreaterThan(1);
  });
});

describe("fallbackDailyQuote", () => {
  it("returns the same text for the same date", () => {
    const a = fallbackDailyQuote("2026-07-16");
    const b = fallbackDailyQuote("2026-07-16");
    expect(a.text).toBe(b.text);
    expect(a.author).toBe(b.author);
    expect(a.generatedBy).toBe("fallback");
    expect(a.text.length).toBeGreaterThan(0);
  });

  it("picks from the built-in rotation", () => {
    const q = fallbackDailyQuote("2026-07-16");
    expect(FALLBACK_QUOTES.some((f) => f.text === q.text)).toBe(true);
  });
});
