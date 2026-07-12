import { addDaysISO, type ISODate, type RecommendationOutcome } from "@/lib/domain";
import { buildEffectivenessReport, type EffectivenessReport } from "@/lib/effectiveness-report";
import { getDomainStore } from "@/server/store";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const SOURCES = new Set<RecommendationOutcome["source"]>([
  "coach-daily",
  "coach-weekly",
  "next-best-action",
]);
const STATUSES = new Set<RecommendationOutcome["status"]>(["accepted", "dismissed", "completed"]);

export type RecordRecommendationOutcomeInput = Omit<RecommendationOutcome, "recordedAt">;

/** Append one immutable, personal-scoped recommendation feedback event. */
export async function recordRecommendationOutcomeImpl(
  data: RecordRecommendationOutcomeInput,
): Promise<RecommendationOutcome> {
  if (typeof data.id !== "string" || !data.id.trim()) {
    throw new Error("Recommendation id is required");
  }
  if (typeof data.date !== "string" || !ISO_DATE_PATTERN.test(data.date)) {
    throw new Error("Valid date is required");
  }
  if (typeof data.text !== "string" || !data.text.trim()) {
    throw new Error("Recommendation text is required");
  }
  if (!SOURCES.has(data.source)) {
    throw new Error("Valid recommendation source is required");
  }
  if (!STATUSES.has(data.status)) {
    throw new Error("Valid recommendation status is required");
  }
  if (data.helpful !== undefined && typeof data.helpful !== "boolean") {
    throw new Error("Helpful must be a boolean");
  }
  if (data.taskId !== undefined && (typeof data.taskId !== "string" || !data.taskId.trim())) {
    throw new Error("Task id must be a non-empty string");
  }

  const record: RecommendationOutcome = {
    ...data,
    id: data.id.trim(),
    text: data.text.trim(),
    taskId: data.taskId?.trim() || undefined,
    recordedAt: Date.now(),
  };
  const store = await getDomainStore();
  await store.log.append("recommendation-outcomes", record.date, record);
  return record;
}

/** Load append-only personal feedback records for the requested day keys. */
export async function loadRecommendationOutcomesImpl(
  dates: ISODate[],
): Promise<RecommendationOutcome[]> {
  if (!Array.isArray(dates) || dates.some((date) => !ISO_DATE_PATTERN.test(date))) {
    throw new Error("Valid dates are required");
  }

  const store = await getDomainStore();
  const records = await Promise.all(
    dates.map((date) => store.log.read<RecommendationOutcome>("recommendation-outcomes", date)),
  );
  return records.flat();
}

/** Load and reduce one personal month of immutable recommendation feedback. */
export async function loadMonthlyEffectivenessImpl(month: string): Promise<EffectivenessReport> {
  if (typeof month !== "string" || !ISO_MONTH_PATTERN.test(month)) {
    throw new Error("Valid month is required");
  }

  const dates: ISODate[] = [];
  for (
    let date = `${month}-01` as ISODate;
    date.slice(0, 7) === month;
    date = addDaysISO(date, 1)
  ) {
    dates.push(date);
  }

  const outcomes = await loadRecommendationOutcomesImpl(dates);
  return buildEffectivenessReport(outcomes, month);
}
