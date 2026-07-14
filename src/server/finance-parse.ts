/**
 * Pure CSV-statement parsing + 50/30/20 categorization helpers (ADR-016).
 *
 * Extracted from `finance.ts` so the money-critical logic is unit-testable in
 * isolation: no server functions, no store access, no auth — string/number in,
 * string/number out. `finance.ts` composes these into the import pipeline.
 */

import type { CategoryGroup } from "@/lib/domain";

/* ============================================================
   CSV PARSING
   A small RFC-4180-ish parser (handles quoted fields, escaped
   quotes, and embedded commas/newlines). No dependency.
   ============================================================ */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/** Column roles we try to locate from a statement's header row. */
export interface ColumnMap {
  date: number;
  description: number;
  amount: number;
  /** Separate debit/credit columns (BoA / Capital One style). */
  debit: number;
  credit: number;
}

export function detectColumns(header: string[]): ColumnMap {
  const norm = header.map((h) => h.trim().toLowerCase());
  const find = (...keys: string[]) => norm.findIndex((h) => keys.some((k) => h.includes(k)));
  return {
    date: find("date", "posted"),
    description: find("description", "payee", "merchant", "name", "memo"),
    amount: find("amount", "value", "amt"),
    debit: find("debit"),
    credit: find("credit"),
  };
}

/** A usable header row has a date column and at least one money column. */
export function isHeaderRow(cols: ColumnMap): boolean {
  return cols.date >= 0 && (cols.amount >= 0 || cols.debit >= 0 || cols.credit >= 0);
}

/**
 * Locate the transaction header row. Bank of America (and some others)
 * prepend a balance-summary block before the real "Date,Description,Amount,…"
 * header, so we can't assume it's row 0. Scan the first chunk of rows for the
 * first one that looks like a real header; fall back to row 0.
 */
export function findHeaderIndex(rows: string[][]): number {
  const limit = Math.min(rows.length, 25);
  for (let i = 0; i < limit; i++) {
    if (isHeaderRow(detectColumns(rows[i]))) return i;
  }
  return 0;
}

export function parseMoney(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const negative = /^\(.*\)$/.test(trimmed) || trimmed.startsWith("-") || trimmed.endsWith("-");
  const normalized = trimmed.replace(/[,$()\s]/g, "").replace(/^-|-$/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return 0;
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return 0;
  return negative ? -amount : amount;
}

/**
 * Parse a statement date cell. Returns null when unparseable — the caller
 * skips (and reports) the row rather than mis-filing it under today's date.
 */
export function parseDate(raw: string): number | null {
  const value = raw.trim();
  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const us = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  const match = iso ?? us;
  if (match) {
    const year = iso
      ? Number(match[1])
      : match[3].length === 2
        ? 2000 + Number(match[3])
        : Number(match[3]);
    const month = iso ? Number(match[2]) : Number(match[1]);
    const day = iso ? Number(match[3]) : Number(match[2]);
    const timestamp = Date.UTC(year, month - 1, day, 12);
    const parsed = new Date(timestamp);
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    )
      return null;
    return timestamp;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/* ============================================================
   CATEGORIZATION (50/30/20)
   Built-in keyword map + learned overrides (category-rules.json).
   ============================================================ */

export const KEYWORD_GROUPS: { group: CategoryGroup; keywords: string[] }[] = [
  {
    group: "income",
    keywords: ["payroll", "adp", "direct dep", "deposit", "salary", "paycheck", "interest paid"],
  },
  {
    group: "transfer",
    keywords: [
      "transfer",
      "zelle",
      "venmo",
      "cash app",
      "withdrawal",
      "atm",
      "online banking",
      "payment thank you",
      "autopay",
      "cc payment",
      // Credit-card / bill payoffs moved out of an account are debt movement,
      // not consumption — excluding them avoids double-counting the card's
      // purchases plus the payment. BoA writes these as "… DES:ONLINE PMT".
      "online pmt",
      "online payment",
      "bill pay",
      "billpay",
      "e-payment",
      "epay",
      "card payment",
      "cardmember serv",
      "card services",
    ],
  },
  {
    group: "savings",
    keywords: [
      "robinhood",
      "vanguard",
      "fidelity",
      "401k",
      "401(k)",
      "ira",
      "brokerage",
      "betterment",
      "wealthfront",
      "acorns",
      "savings",
    ],
  },
  {
    group: "needs",
    keywords: [
      "rent",
      "mortgage",
      "m&t",
      "electric",
      "gas company",
      "water",
      "utility",
      "internet",
      "comcast",
      "xfinity",
      "verizon",
      "at&t",
      "t-mobile",
      "insurance",
      "geico",
      "progressive",
      "pharmacy",
      "cvs",
      "walgreens",
      "doctor",
      "medical",
      "grocery",
      "groceries",
      "safeway",
      "kroger",
      "wegmans",
      "aldi",
      "costco",
      "walmart",
      "target",
      "shell",
      "exxon",
      "chevron",
      "bp",
      "fuel",
      "childcare",
      "daycare",
      "tuition",
      "student loan",
    ],
  },
  {
    group: "wants",
    keywords: [
      "netflix",
      "hulu",
      "spotify",
      "disney",
      "hbo",
      "max",
      "youtube",
      "prime video",
      "apple",
      "amazon",
      "doordash",
      "uber eats",
      "grubhub",
      "restaurant",
      "starbucks",
      "dunkin",
      "mcdonald",
      "chipotle",
      "bar ",
      "steakhouse",
      "cafe",
      "coffee",
      "steam",
      "playstation",
      "xbox",
      "nintendo",
      "gym",
      "planet fitness",
      "peloton",
      "golf",
      "hotel",
      "airbnb",
      "airline",
      "delta",
      "united",
      "ticket",
      "cinema",
      "amc",
    ],
  },
];

// Canonical implementations live in finance-math (shared with client-safe
// recurring detection). Re-exported here so existing server callers keep working.
import { normalizeMerchant } from "@/lib/finance-math";
export { normalizeMerchant, inferCadence } from "@/lib/finance-math";

export function ruleGroupFor(
  description: string,
  rules: Record<string, CategoryGroup>,
): CategoryGroup | null {
  const norm = normalizeMerchant(description);
  for (const [key, group] of Object.entries(rules)) {
    if (norm.includes(key)) return group;
  }
  return null;
}

export function categorize(
  description: string,
  amount: number,
  rules: Record<string, CategoryGroup>,
): CategoryGroup {
  // Learned overrides win.
  const ruleGroup = ruleGroupFor(description, rules);
  if (ruleGroup) return ruleGroup;
  const haystack = description.toLowerCase();
  for (const { group, keywords } of KEYWORD_GROUPS) {
    if (keywords.some((k) => haystack.includes(k))) return group;
  }
  // Unknown: positive = income, negative spend defaults to discretionary (wants)
  // so it surfaces for review rather than silently inflating "needs".
  return amount > 0 ? "income" : "wants";
}

export function dedupeKeyFor(t: {
  timestamp: number;
  amount: number;
  description: string;
  account?: string;
}): string {
  const day = new Date(t.timestamp).toISOString().slice(0, 10);
  return `${day}|${t.amount.toFixed(2)}|${normalizeMerchant(t.description)}|${t.account ?? ""}`;
}
