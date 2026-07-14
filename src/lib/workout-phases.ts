import type { ExercisePhase } from "@/lib/domain";

/** Render order of the session arc. */
export const PHASE_ORDER: ExercisePhase[] = ["warmup", "main", "core", "cooldown"];

export interface PhaseMeta {
  label: string;
  /** Solid swatch (dots / fills). */
  dot: string;
  /** Foreground text color. */
  text: string;
}

export const PHASE_META: Record<ExercisePhase, PhaseMeta> = {
  warmup: {
    label: "Warm-up",
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-500",
  },
  main: {
    label: "Main",
    dot: "bg-primary",
    text: "text-primary",
  },
  core: {
    label: "Core",
    dot: "bg-primary",
    text: "text-primary",
  },
  cooldown: {
    label: "Cooldown",
    dot: "bg-teal-600",
    text: "text-teal-700 dark:text-teal-400",
  },
};

/** Stable, filesystem-safe slug for an exercise name (mirrors the server). */
export function slugifyExercise(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "exercise"
  );
}

/** URL for an exercise silhouette (lazily generated + cached server-side). */
export function exerciseImageUrl(name: string): string {
  return `/api/exercise-image/${slugifyExercise(name)}?name=${encodeURIComponent(name)}`;
}
