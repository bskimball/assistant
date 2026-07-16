import type { RecommendationOutcome } from "@/lib/domain";

export type RecommendationSource = RecommendationOutcome["source"];

export interface EffectivenessBreakdown {
  total: number;
  accepted: number;
  completed: number;
  dismissed: number;
  snoozed: number;
  helpfulYes: number;
  helpfulNo: number;
  completionRate: number;
}

export interface EffectivenessReport extends EffectivenessBreakdown {
  month: string;
  bySource: Record<RecommendationSource, EffectivenessBreakdown>;
  topCompleted: string[];
}

const SOURCES: RecommendationSource[] = [
  "coach-daily",
  "coach-weekly",
  "next-best-action",
  "health-next-action",
];

function emptyBreakdown(): EffectivenessBreakdown {
  return {
    total: 0,
    accepted: 0,
    completed: 0,
    dismissed: 0,
    snoozed: 0,
    helpfulYes: 0,
    helpfulNo: 0,
    completionRate: 0,
  };
}

function compareStrings(a: string, b: string): number {
  return a === b ? 0 : a > b ? 1 : -1;
}

function compareOutcome(a: RecommendationOutcome, b: RecommendationOutcome): number {
  return compareStrings(
    [a.date, a.source, a.status, a.text, String(a.helpful ?? ""), a.taskId ?? ""].join("\u0000"),
    [b.date, b.source, b.status, b.text, String(b.helpful ?? ""), b.taskId ?? ""].join("\u0000"),
  );
}

function addOutcome(breakdown: EffectivenessBreakdown, outcome: RecommendationOutcome): void {
  breakdown.total++;
  breakdown[outcome.status]++;
  if (outcome.helpful === true) breakdown.helpfulYes++;
  if (outcome.helpful === false) breakdown.helpfulNo++;
}

function withCompletionRate(breakdown: EffectivenessBreakdown): EffectivenessBreakdown {
  const denominator = breakdown.accepted + breakdown.completed;
  return {
    ...breakdown,
    completionRate: denominator ? breakdown.completed / denominator : 0,
  };
}

/**
 * Reduces immutable recommendation feedback events into one deterministic month
 * report. A recommendation can emit multiple events; only its newest event in
 * the requested month contributes to the report.
 */
export function buildEffectivenessReport(
  outcomes: RecommendationOutcome[],
  month: string,
): EffectivenessReport {
  const latestById = new Map<string, RecommendationOutcome>();

  for (const outcome of outcomes) {
    if (outcome.date.slice(0, 7) !== month) continue;
    const current = latestById.get(outcome.id);
    if (
      !current ||
      outcome.recordedAt > current.recordedAt ||
      (outcome.recordedAt === current.recordedAt && compareOutcome(outcome, current) > 0)
    ) {
      latestById.set(outcome.id, outcome);
    }
  }

  const bySource = Object.fromEntries(
    SOURCES.map((source) => [source, emptyBreakdown()]),
  ) as Record<RecommendationSource, EffectivenessBreakdown>;
  const total = emptyBreakdown();
  const finalOutcomes = [...latestById.values()];

  for (const outcome of finalOutcomes) {
    addOutcome(total, outcome);
    addOutcome(bySource[outcome.source], outcome);
  }

  const completed = finalOutcomes
    .filter((outcome) => outcome.status === "completed")
    .sort(
      (a, b) => b.recordedAt - a.recordedAt || compareStrings(b.id, a.id) || compareOutcome(b, a),
    )
    .slice(0, 5)
    .map((outcome) => outcome.text);

  return {
    month,
    ...withCompletionRate(total),
    bySource: Object.fromEntries(
      SOURCES.map((source) => [source, withCompletionRate(bySource[source])]),
    ) as Record<RecommendationSource, EffectivenessBreakdown>,
    topCompleted: completed,
  };
}
