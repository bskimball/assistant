export type NextBestActionDomain = "focus" | "fitness" | "nutrition" | "finance" | "general";

export interface NextBestAction {
  domain: NextBestActionDomain;
  title: string;
  reason: string;
  href: "/kanban" | "/workouts" | "/nutrition" | "/finance" | "/weekly";
}

export interface NextBestActionInput {
  incompleteTopTask?: { title: string; overdue?: boolean };
  plannedWorkoutIncomplete?: boolean;
  plannedWorkoutTitle?: string;
  hourLocal?: number;
  proteinPct?: number;
  waterPct?: number;
  financeStatus?: "unavailable" | "on-track" | "tight" | "over-plan";
  safeToSpendThisMonth?: number;
}

export function selectNextBestAction(input: NextBestActionInput): NextBestAction {
  if (input.incompleteTopTask) {
    return {
      domain: "focus",
      title: input.incompleteTopTask.title,
      reason: input.incompleteTopTask.overdue
        ? "This priority is overdue. Finishing it prevents another carryover."
        : "This is your highest-priority unfinished task today.",
      href: "/kanban",
    };
  }
  if (input.plannedWorkoutIncomplete) {
    return {
      domain: "fitness",
      title: input.plannedWorkoutTitle || "Complete today’s workout",
      reason:
        "Your planned session is still open. Use the short or minimum version if time is tight.",
      href: "/workouts",
    };
  }
  if ((input.hourLocal ?? 0) >= 16 && (input.proteinPct ?? 100) < 80) {
    return {
      domain: "nutrition",
      title: "Close today’s protein gap",
      reason: `You are at ${Math.round(input.proteinPct ?? 0)}% of today’s protein target.`,
      href: "/nutrition",
    };
  }
  if ((input.hourLocal ?? 0) >= 16 && (input.waterPct ?? 100) < 70) {
    return {
      domain: "nutrition",
      title: "Catch up on hydration",
      reason: `You are at ${Math.round(input.waterPct ?? 0)}% of today’s hydration target.`,
      href: "/nutrition",
    };
  }
  if (input.financeStatus === "over-plan" || input.financeStatus === "tight") {
    return {
      domain: "finance",
      title: "Review the household spending guardrail",
      reason:
        input.financeStatus === "over-plan"
          ? "Committed spending is currently over the monthly plan."
          : `Only $${Math.max(0, input.safeToSpendThisMonth ?? 0).toLocaleString()} remains in the monthly guardrail.`,
      href: "/finance",
    };
  }
  return {
    domain: "general",
    title: "Review your week and choose one meaningful win",
    reason: "Your immediate commitments are on track. Use the weekly view to protect momentum.",
    href: "/weekly",
  };
}
