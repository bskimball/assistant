import type { RecommendationOutcome } from "@/lib/domain";

export interface RecommendationLearning {
  /** Newest event per recommendation id. */
  latest: RecommendationOutcome[];
  completedTexts: string[];
  helpfulTexts: string[];
  notHelpfulTexts: string[];
  dismissedTexts: string[];
  snoozedTexts: string[];
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

function takeTexts(
  outcomes: RecommendationOutcome[],
  predicate: (outcome: RecommendationOutcome) => boolean,
  limit = 5,
): string[] {
  return outcomes
    .filter(predicate)
    .sort(
      (a, b) => b.recordedAt - a.recordedAt || compareStrings(b.id, a.id) || compareOutcome(b, a),
    )
    .slice(0, limit)
    .map((outcome) => outcome.text);
}

/**
 * Reduce append-only recommendation feedback into the newest state per id so
 * the coach can avoid repeating what the member dismissed or marked not helpful.
 */
export function summarizeRecommendationLearning(
  outcomes: RecommendationOutcome[],
): RecommendationLearning {
  const latestById = new Map<string, RecommendationOutcome>();

  for (const outcome of outcomes) {
    const current = latestById.get(outcome.id);
    if (
      !current ||
      outcome.recordedAt > current.recordedAt ||
      (outcome.recordedAt === current.recordedAt && compareOutcome(outcome, current) > 0)
    ) {
      latestById.set(outcome.id, outcome);
    }
  }

  const latest = [...latestById.values()];
  return {
    latest,
    completedTexts: takeTexts(latest, (o) => o.status === "completed"),
    helpfulTexts: takeTexts(latest, (o) => o.helpful === true),
    notHelpfulTexts: takeTexts(latest, (o) => o.helpful === false),
    dismissedTexts: takeTexts(latest, (o) => o.status === "dismissed"),
    snoozedTexts: takeTexts(latest, (o) => o.status === "snoozed"),
  };
}

/** Normalize recommendation text for fuzzy de-dupe against past feedback. */
export function normalizeRecommendationText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * True when a candidate suggestion is too similar to something the member
 * recently dismissed or marked not helpful.
 */
export function isAvoidedRecommendation(
  text: string,
  learning: Pick<RecommendationLearning, "dismissedTexts" | "notHelpfulTexts">,
): boolean {
  const normalized = normalizeRecommendationText(text);
  if (!normalized) return false;
  const avoided = [...learning.dismissedTexts, ...learning.notHelpfulTexts].map(
    normalizeRecommendationText,
  );
  return avoided.some(
    (prior) =>
      prior === normalized ||
      (prior.length >= 24 && normalized.includes(prior)) ||
      (normalized.length >= 24 && prior.includes(normalized)),
  );
}

/** Compact bullet list for coach prompts (empty string when nothing useful). */
export function recommendationLearningBlock(learning: RecommendationLearning): string {
  const lines: string[] = [];
  if (learning.helpfulTexts.length) {
    lines.push(
      `- Helpful recently (repeat patterns, not verbatim): ${learning.helpfulTexts.join(" | ")}`,
    );
  }
  if (learning.completedTexts.length) {
    lines.push(`- Completed recently: ${learning.completedTexts.join(" | ")}`);
  }
  if (learning.notHelpfulTexts.length) {
    lines.push(
      `- NOT helpful (do not repeat or rephrase closely): ${learning.notHelpfulTexts.join(" | ")}`,
    );
  }
  if (learning.dismissedTexts.length) {
    lines.push(
      `- Dismissed (avoid unless circumstances clearly changed): ${learning.dismissedTexts.join(" | ")}`,
    );
  }
  if (learning.snoozedTexts.length) {
    lines.push(`- Snoozed (defer; do not push today): ${learning.snoozedTexts.join(" | ")}`);
  }
  return lines.length ? lines.join("\n") : "";
}
