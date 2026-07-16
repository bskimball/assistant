export type HealthWorkflowIntent = "log-meal" | "start-workout" | "choose-workout";

const HEALTH_ACTION_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validHealthAction(value: unknown): string | undefined {
  return typeof value === "string" && HEALTH_ACTION_PATTERN.test(value) ? value : undefined;
}

export function validateNutritionSearch(search: Record<string, unknown>): {
  date?: string;
  healthAction?: string;
  intent?: "log-meal";
} {
  const date =
    typeof search.date === "string" && ISO_DATE_PATTERN.test(search.date) ? search.date : undefined;
  const healthAction = validHealthAction(search.healthAction);
  const isCurrentDay = !date || date === todayISO();
  const intent =
    search.intent === "log-meal" && healthAction && isCurrentDay ? "log-meal" : undefined;
  return { date, healthAction: intent ? healthAction : undefined, intent };
}

export function validateWorkoutSearch(search: Record<string, unknown>): {
  healthAction?: string;
  intent?: "start-workout" | "choose-workout";
} {
  const healthAction = validHealthAction(search.healthAction);
  const intent =
    search.intent === "start-workout" || search.intent === "choose-workout"
      ? search.intent
      : undefined;
  return {
    healthAction: intent && healthAction ? healthAction : undefined,
    intent: healthAction ? intent : undefined,
  };
}
import { todayISO } from "@/lib/domain";
