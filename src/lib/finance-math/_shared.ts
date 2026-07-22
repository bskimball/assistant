import type { ISODate, Subscription } from "@/lib/domain";
import { cleanMerchantName, toISODate } from "@/lib/domain";

export type BudgetBucket = "needs" | "wants" | "savings";

export interface MonthBuckets {
  needs: number;
  wants: number;
  savings: number;
  income: number;
  month: string;
}

export const DAY = 24 * 60 * 60 * 1000;

export type BudgetLike = {
  monthlyTakeHome: number;
  targets: { needs: number; wants: number; savings: number };
} | null;

export function dollars(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function positive(n: number | undefined): number {
  return Number.isFinite(n) && n && n > 0 ? n : 0;
}

export function addMonthsKey(month: string, offset: number): string {
  const [year, monthIndex] = month.split("-").map(Number);
  if (!year || !monthIndex) return month;
  return new Date(Date.UTC(year, monthIndex - 1 + offset, 1)).toISOString().slice(0, 7);
}

export function monthKey(timestamp: number): string {
  return toISODate(timestamp).slice(0, 7);
}

/**
 * Normalize a bank descriptor for grouping/dedupe: lowercase, strip long numbers
 * (store ids, phones), drop non-alpha noise. Kept separate from
 * `normalizedFinanceLabel` (which title-cleans for display matching) so raw
 * statement variants still collapse to one merchant key.
 */
export function normalizeMerchant(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/\b\d{2,}\b/g, "") // strip long numbers (store ids, dates)
    .replace(/[^a-z& ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Map an average inter-charge gap (days) to a known cadence, or null if irregular. */
export function inferCadence(intervalDays: number): Subscription["cadence"] | null {
  if (intervalDays >= 5 && intervalDays <= 9) return "weekly";
  if (intervalDays >= 26 && intervalDays <= 35) return "monthly";
  if (intervalDays >= 350 && intervalDays <= 380) return "annual";
  return null;
}

export function normalizedFinanceLabel(raw?: string): string {
  return cleanMerchantName(raw || "").toLowerCase();
}

export function daysInMonthUTC(timestamp: number): number {
  const d = new Date(timestamp);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Return a month key offset without converting an ISO day through local time. */
export function addMonthsToKey(month: string, offset: number): string {
  const [year, monthIndex] = month.split("-").map(Number);
  const shifted = year * 12 + (monthIndex - 1) + offset;
  const nextYear = Math.floor(shifted / 12);
  const nextMonth = (shifted % 12) + 1;
  return `${nextYear.toString().padStart(4, "0")}-${nextMonth.toString().padStart(2, "0")}`;
}

export function daysInISOMonth(month: string): number {
  const [year, monthIndex] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
}

export function dateInMonth(month: string, day: number): ISODate {
  const safeDay = Math.min(Math.max(1, Math.floor(day)), daysInISOMonth(month));
  return `${month}-${safeDay.toString().padStart(2, "0")}`;
}
