import { describe, expect, it } from "vitest";
import {
  categorize,
  dedupeKeyFor,
  detectColumns,
  findHeaderIndex,
  inferCadence,
  normalizeMerchant,
  parseCsv,
  parseDate,
  parseMoney,
  ruleGroupFor,
} from "@/server/finance-parse";

describe("parseCsv", () => {
  it("parses simple rows", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with embedded commas and escaped quotes", () => {
    const csv = '"Date","Description","Amount"\n"06/01/2026","AMAZON, INC ""PRIME""","-14.99"';
    expect(parseCsv(csv)).toEqual([
      ["Date", "Description", "Amount"],
      ["06/01/2026", 'AMAZON, INC "PRIME"', "-14.99"],
    ]);
  });

  it("handles embedded newlines inside quotes and CRLF line endings", () => {
    const csv = 'a,b\r\n"line1\nline2",2\r\n';
    expect(parseCsv(csv)).toEqual([
      ["a", "b"],
      ["line1\nline2", "2"],
    ]);
  });

  it("drops blank rows", () => {
    expect(parseCsv("a,b\n,\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("header detection", () => {
  it("finds the header row past a BoA-style summary preamble", () => {
    const rows = parseCsv(
      [
        "Description,,Summary Amt.",
        "Beginning balance as of 05/01/2026,,1000.00",
        "Total credits,,500.00",
        "Date,Description,Amount,Running Bal.",
        "05/02/2026,PAYROLL DES:ADP,2500.00,3500.00",
      ].join("\n"),
    );
    const idx = findHeaderIndex(rows);
    expect(idx).toBe(3);
    const cols = detectColumns(rows[idx]);
    expect(cols.date).toBe(0);
    expect(cols.description).toBe(1);
    expect(cols.amount).toBe(2);
  });

  it("detects separate debit/credit columns", () => {
    const cols = detectColumns(["Posted Date", "Payee", "Debit", "Credit"]);
    expect(cols.date).toBe(0);
    expect(cols.description).toBe(1);
    expect(cols.debit).toBe(2);
    expect(cols.credit).toBe(3);
  });
});

describe("parseMoney", () => {
  it("parses plain, formatted, and negative amounts", () => {
    expect(parseMoney("14.99")).toBe(14.99);
    expect(parseMoney("$1,234.56")).toBe(1234.56);
    expect(parseMoney("-42.00")).toBe(-42);
    expect(parseMoney("(42.00)")).toBe(-42); // accounting-style negative
    expect(parseMoney("42.00-")).toBe(-42); // trailing-minus bank export
  });

  it("returns 0 for empty or non-numeric cells", () => {
    expect(parseMoney("")).toBe(0);
    expect(parseMoney("n/a")).toBe(0);
    expect(parseMoney("12-34")).toBe(0);
  });
});

describe("parseDate", () => {
  it("parses common statement formats", () => {
    expect(parseDate("2026-06-15")).not.toBeNull();
    expect(parseDate("06/15/2026")).not.toBeNull();
    expect(parseDate("6/5/26")).not.toBeNull();
  });

  it("returns null (not today) for unparseable cells", () => {
    expect(parseDate("")).toBeNull();
    expect(parseDate("pending")).toBeNull();
    expect(parseDate("--")).toBeNull();
    expect(parseDate("02/30/2026")).toBeNull();
    expect(parseDate("2026-02-30")).toBeNull();
  });
});

describe("categorize", () => {
  it("maps known keywords to their 50/30/20 groups", () => {
    expect(categorize("PAYROLL DES:ADP", 2500, {})).toBe("income");
    expect(categorize("NETFLIX.COM", -15.49, {})).toBe("wants");
    expect(categorize("WEGMANS #84 GROCERY", -120.5, {})).toBe("needs");
    expect(categorize("ROBINHOOD FUNDS", -500, {})).toBe("savings");
    expect(categorize("Zelle payment to John", -50, {})).toBe("transfer");
  });

  it("treats card payoffs as transfers, not spending", () => {
    expect(categorize("CAPITAL ONE DES:ONLINE PMT", -800, {})).toBe("transfer");
  });

  it("lets learned rules win over built-in keywords", () => {
    const rules = { "planet fitness": "needs" as const };
    expect(categorize("PLANET FITNESS 123", -10, rules)).toBe("needs");
  });

  it("returns learned rule groups or null without keyword fallback", () => {
    const rules = { "planet fitness": "needs" as const };
    expect(ruleGroupFor("PLANET FITNESS 123", rules)).toBe("needs");
    expect(ruleGroupFor("NETFLIX.COM", rules)).toBeNull();
  });

  it("defaults unknowns by sign: positive income, negative wants", () => {
    expect(categorize("MYSTERY VENDOR 42", 100, {})).toBe("income");
    expect(categorize("MYSTERY VENDOR 42", -100, {})).toBe("wants");
  });
});

describe("normalizeMerchant / dedupeKeyFor", () => {
  it("strips store ids and punctuation so the same merchant collapses", () => {
    expect(normalizeMerchant("STARBUCKS #1234 SEATTLE")).toBe(
      normalizeMerchant("STARBUCKS #5678 SEATTLE"),
    );
  });

  it("produces identical keys for re-imported rows and distinct keys otherwise", () => {
    const t = { timestamp: Date.UTC(2026, 5, 15), amount: -14.99, description: "NETFLIX.COM" };
    expect(dedupeKeyFor(t)).toBe(dedupeKeyFor({ ...t }));
    expect(dedupeKeyFor(t)).not.toBe(dedupeKeyFor({ ...t, amount: -15.49 }));
    expect(dedupeKeyFor(t)).not.toBe(dedupeKeyFor({ ...t, account: "BoA" }));
  });
});

describe("inferCadence", () => {
  it("classifies weekly, monthly, and annual intervals", () => {
    expect(inferCadence(7)).toBe("weekly");
    expect(inferCadence(30)).toBe("monthly");
    expect(inferCadence(31)).toBe("monthly");
    expect(inferCadence(365)).toBe("annual");
  });

  it("rejects irregular intervals", () => {
    expect(inferCadence(3)).toBeNull();
    expect(inferCadence(15)).toBeNull();
    expect(inferCadence(100)).toBeNull();
  });
});
