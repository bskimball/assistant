/** Coach Engine workout rotation and weekly plan composition (ADR-011). */

import type {
  ISODate,
  PlannedWorkoutSession,
  UserProfile,
  WorkoutPlan,
  WorkoutStyle,
} from "@/lib/domain";
import { addDaysISO, newId } from "@/lib/domain";
import { loadWorkoutPlansImpl, saveWorkoutPlansImpl } from "@/server/domain-impl";
import type { WorkoutSuggestion } from "@/server/coach-daily-impl";

/* ============================================================
   WORKOUT TEMPLATES (trainer)
   A Centr-style blend so a week mixes traditional strength, bodyweight
   calisthenics, and yoga/mobility — building strength AND flexibility.
   Each template is tagged with a `modality` so the weekly planner can
   guarantee variety instead of stacking only barbell sessions.
   ============================================================ */

/**
 * `style` is the user-facing category used to honor workout preferences.
 * `load` is the muscle area taxed, used only to space the week so overlapping
 * areas never land on consecutive training days ("full" = full-body, "light"
 * = recovery/core that can sit anywhere).
 */
interface WorkoutTemplate extends WorkoutSuggestion {
  style: WorkoutStyle;
  load: "push" | "pull" | "legs" | "full" | "light";
}

/** Named templates keyed by intent (avoids fragile index references). */
const TEMPLATES = {
  recoveryYoga: {
    style: "yoga",
    load: "light",
    title: "Yoga & Deep Stretch",
    focus: "Flexibility + recovery",
    estimatedMinutes: 25,
    exercises: [
      { name: "Cat-cow + child’s pose", sets: 2, reps: "8 breaths" },
      { name: "Downward dog → low lunge flow", sets: 2, reps: "5/side" },
      { name: "Pigeon pose", sets: 1, reps: "90s/side" },
      { name: "Seated forward fold", sets: 1, reps: "2 min" },
      { name: "Supine spinal twist", sets: 1, reps: "60s/side" },
    ],
  },
  push: {
    style: "strength",
    load: "push",
    title: "Push — Chest, Shoulders, Triceps",
    focus: "Upper push",
    estimatedMinutes: 45,
    exercises: [
      { name: "Bench press", sets: 4, reps: "6–8" },
      { name: "Overhead press", sets: 3, reps: "8–10" },
      { name: "Incline dumbbell press", sets: 3, reps: "10–12" },
      { name: "Triceps rope pushdown", sets: 3, reps: "12–15" },
    ],
  },
  pull: {
    style: "strength",
    load: "pull",
    title: "Pull — Back & Biceps",
    focus: "Upper pull",
    estimatedMinutes: 45,
    exercises: [
      { name: "Deadlift", sets: 3, reps: "5" },
      { name: "Pull-ups", sets: 4, reps: "AMRAP" },
      { name: "Barbell row", sets: 3, reps: "8–10" },
      { name: "Face pulls", sets: 3, reps: "15" },
    ],
  },
  legs: {
    style: "strength",
    load: "legs",
    title: "Legs — Quads, Hamstrings, Glutes",
    focus: "Lower body",
    estimatedMinutes: 50,
    exercises: [
      { name: "Back squat", sets: 4, reps: "6–8" },
      { name: "Romanian deadlift", sets: 3, reps: "10" },
      { name: "Walking lunges", sets: 3, reps: "12/leg" },
      { name: "Calf raises", sets: 4, reps: "15" },
    ],
  },
  calisthenics: {
    style: "calisthenics",
    load: "full",
    title: "Calisthenics — Bodyweight Strength",
    focus: "Full-body bodyweight",
    estimatedMinutes: 35,
    exercises: [
      { name: "Push-up variations", sets: 4, reps: "12–15" },
      { name: "Pull-ups or inverted rows", sets: 4, reps: "AMRAP" },
      { name: "Bulgarian split squat", sets: 3, reps: "10/leg" },
      { name: "Dips", sets: 3, reps: "10–12" },
      { name: "Hollow-body hold", sets: 3, reps: "30s" },
    ],
  },
  powerYoga: {
    style: "yoga",
    load: "light",
    title: "Power Yoga Flow",
    focus: "Strength + flexibility",
    estimatedMinutes: 35,
    exercises: [
      { name: "Sun salutation A & B", sets: 5, reps: "flow" },
      {
        name: "Warrior I → II → reverse warrior",
        sets: 2,
        reps: "5 breaths/side",
      },
      { name: "Chair → crescent lunge hold", sets: 2, reps: "5 breaths/side" },
      { name: "Side plank", sets: 2, reps: "30s/side" },
      { name: "Pigeon + seated forward fold", sets: 1, reps: "2 min/side" },
    ],
  },
  conditioning: {
    style: "conditioning",
    load: "light",
    title: "Conditioning & Core",
    focus: "Conditioning",
    estimatedMinutes: 30,
    exercises: [
      { name: "Row or bike intervals", sets: 6, reps: "40s on / 20s off" },
      { name: "Hanging knee raise", sets: 3, reps: "12" },
      { name: "Plank", sets: 3, reps: "45s" },
      { name: "Russian twists", sets: 3, reps: "20" },
    ],
  },
} satisfies Record<string, WorkoutTemplate>;

/* ============================================================
   SESSION ARC (warm-up → main → core → cooldown)
   Every structured strength session is expanded so prep and recovery are
   never skipped. Warm-ups and cooldowns are tailored to the area worked;
   strength/calisthenics days also get a dedicated core finisher.
   ============================================================ */

type Ex = WorkoutSuggestion["exercises"][number];

/** Dynamic warm-ups keyed by the area the main work taxes. */
const WARMUPS: Record<"upper" | "lower" | "general", Ex[]> = {
  upper: [
    {
      name: "Jump rope or arm circles",
      sets: 1,
      reps: "3 min",
      phase: "warmup",
    },
    { name: "Band pull-aparts", sets: 2, reps: "15", phase: "warmup" },
    {
      name: "Scapular push-ups + cat-cow",
      sets: 2,
      reps: "10",
      phase: "warmup",
    },
  ],
  lower: [
    {
      name: "Easy bike or brisk walk",
      sets: 1,
      reps: "3 min",
      phase: "warmup",
    },
    {
      name: "Leg swings (front + side)",
      sets: 1,
      reps: "10/leg",
      phase: "warmup",
    },
    {
      name: "Bodyweight squats + hip circles",
      sets: 2,
      reps: "12",
      phase: "warmup",
    },
  ],
  general: [
    { name: "Easy row or bike", sets: 1, reps: "4 min", phase: "warmup" },
    {
      name: "Dynamic leg swings + arm circles",
      sets: 1,
      reps: "10 each",
      phase: "warmup",
    },
    {
      name: "World's greatest stretch",
      sets: 1,
      reps: "5/side",
      phase: "warmup",
    },
  ],
};

/** Core/abs finisher that closes the strength portion. */
const CORE_FINISHER: Ex[] = [
  { name: "Plank", sets: 3, reps: "45s", phase: "core" },
  { name: "Hanging knee raises", sets: 3, reps: "12", phase: "core" },
  { name: "Dead bug", sets: 3, reps: "10/side", phase: "core" },
];

/** Cooldown stretching tailored to the area worked. */
const COOLDOWNS: Record<"upper" | "lower" | "general", Ex[]> = {
  upper: [
    {
      name: "Doorway chest stretch",
      sets: 1,
      reps: "45s/side",
      phase: "cooldown",
    },
    {
      name: "Cross-body shoulder + triceps stretch",
      sets: 1,
      reps: "30s/side",
      phase: "cooldown",
    },
    { name: "Child's pose", sets: 1, reps: "60s", phase: "cooldown" },
  ],
  lower: [
    {
      name: "Standing quad stretch",
      sets: 1,
      reps: "45s/side",
      phase: "cooldown",
    },
    {
      name: "Seated hamstring forward fold",
      sets: 1,
      reps: "60s",
      phase: "cooldown",
    },
    {
      name: "Figure-4 glute stretch",
      sets: 1,
      reps: "45s/side",
      phase: "cooldown",
    },
  ],
  general: [
    { name: "Standing forward fold", sets: 1, reps: "60s", phase: "cooldown" },
    {
      name: "Supine spinal twist",
      sets: 1,
      reps: "45s/side",
      phase: "cooldown",
    },
    { name: "Child's pose", sets: 1, reps: "60s", phase: "cooldown" },
  ],
};

function warmupKey(load: WorkoutTemplate["load"]): "upper" | "lower" | "general" {
  if (load === "legs") return "lower";
  if (load === "push" || load === "pull") return "upper";
  return "general"; // full-body / light
}

/**
 * Expand a template into a full session arc: warm-up → main → core → cooldown.
 * Yoga/mobility sessions are already a self-contained flow (their own warm-up
 * and deep stretch), so they pass through with their moves tagged as the main
 * work and no extra blocks bolted on. Strength and calisthenics days also get
 * a dedicated core finisher; conditioning already trains core in its circuit.
 */
function composeSession(t: WorkoutTemplate): WorkoutSuggestion {
  const main: Ex[] = t.exercises.map((e) => ({ ...e, phase: "main" as const }));
  if (t.style === "yoga") {
    return {
      title: t.title,
      focus: t.focus,
      estimatedMinutes: t.estimatedMinutes,
      exercises: main,
    };
  }
  const key = warmupKey(t.load);
  const needsCore = t.style === "strength" || t.style === "calisthenics";
  const exercises = [
    ...WARMUPS[key],
    ...main,
    ...(needsCore ? CORE_FINISHER : []),
    ...COOLDOWNS[key],
  ];
  return {
    title: t.title,
    focus: t.focus,
    // Warm-up + cooldown add ~11 min; the core finisher adds ~6 more.
    estimatedMinutes: t.estimatedMinutes + 11 + (needsCore ? 6 : 0),
    exercises,
  };
}

/**
 * Priority-ordered candidate sessions. The weekly planner filters this to the
 * user's preferred styles (or the balanced default), takes/cycles enough for
 * the week, then spaces them. Order matters: strength sub-sessions first so a
 * short week covers push/pull/legs before adding calisthenics, then yoga.
 */
const SESSION_PRIORITY: WorkoutTemplate[] = [
  TEMPLATES.push,
  TEMPLATES.pull,
  TEMPLATES.legs,
  TEMPLATES.calisthenics,
  TEMPLATES.powerYoga,
  TEMPLATES.conditioning,
];

/** Default mix when the user hasn't set a preference. */
const DEFAULT_WORKOUT_STYLES: WorkoutStyle[] = ["strength", "calisthenics", "yoga"];

/**
 * Bump when the session template structure changes so existing weekly plans are
 * transparently rebuilt on next load. v2 introduced the warm-up → main → core →
 * cooldown arc.
 */
const WORKOUT_PLAN_VERSION = 2;

/** Two sessions conflict if they tax the same area heavily on adjacent days. */
function loadsConflict(a: WorkoutTemplate["load"], b: WorkoutTemplate["load"]): boolean {
  if (a === "light" || b === "light") return false;
  if (a === "full" || b === "full") return true; // full-body overlaps any strength day
  return a === b; // same strength subgroup back-to-back
}

export function fallbackWorkout(dayOfWeek: number): WorkoutSuggestion {
  // Blend across the week: strength, calisthenics, and yoga/recovery days.
  const byDay: Record<number, WorkoutTemplate> = {
    0: TEMPLATES.powerYoga, // Sun — flexibility focus
    1: TEMPLATES.push,
    2: TEMPLATES.calisthenics,
    3: TEMPLATES.recoveryYoga, // Wed — active recovery
    4: TEMPLATES.pull,
    5: TEMPLATES.legs,
    6: TEMPLATES.conditioning,
  };
  return composeSession(byDay[dayOfWeek] ?? TEMPLATES.push);
}

function weekBounds(date: ISODate): { start: ISODate; end: ISODate } {
  const day = new Date(date + "T12:00:00Z").getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = addDaysISO(date, mondayOffset);
  return { start, end: addDaysISO(start, 6) };
}

function trainingDayIndexes(target = 3): number[] {
  if (target <= 2) return [0, 3].slice(0, target);
  if (target === 3) return [0, 2, 4];
  if (target === 4) return [0, 1, 3, 5];
  return [0, 1, 3, 4, 5].slice(0, Math.min(5, target));
}

/**
 * Order the week's training sessions so the split makes sense across the week,
 * honoring the user's preferred styles (or the balanced default).
 *
 * 1. Pick the candidate sessions for the chosen styles, in priority order.
 * 2. Cycle them to fill `count` training days (so a strength-only week rotates
 *    push/pull/legs, a yoga-only week is all yoga, etc.).
 * 3. Greedily reorder so no two sessions that tax the same area heavily land on
 *    consecutive training days. The returned list is consumed in calendar order;
 *    `trainingDayIndexes` can place training days adjacent (Sun+Mon, or
 *    Wed+Thu+Fri at 5/wk), so keeping list neighbours conflict-free keeps the
 *    calendar conflict-free. Calisthenics is full-body, so yoga/conditioning
 *    days act as the buffer between it and heavy strength days.
 *
 * With the default styles this reproduces the curated blend, e.g. 5/wk →
 * push, pull, legs, power yoga, calisthenics.
 */
function balancedTrainingBlend(count: number, preferred: WorkoutStyle[]): WorkoutTemplate[] {
  const n = Math.max(0, Math.min(5, count));
  if (n === 0) return [];

  const styles = preferred.length ? preferred : DEFAULT_WORKOUT_STYLES;
  const pool = SESSION_PRIORITY.filter((t) => styles.includes(t.style));
  if (pool.length === 0) return [];

  // Fill the week by cycling the candidate pool (strength cycles push/pull/legs).
  const candidates = Array.from({ length: n }, (_, i) => pool[i % pool.length]);

  // Greedy spacing: each step take the first remaining session that doesn't
  // conflict with the previous one; fall back to the next available if forced.
  const ordered: WorkoutTemplate[] = [];
  const remaining = [...candidates];
  while (remaining.length) {
    const prev = ordered[ordered.length - 1];
    let idx = remaining.findIndex((t) => !prev || !loadsConflict(prev.load, t.load));
    if (idx === -1) idx = 0;
    ordered.push(remaining[idx]);
    remaining.splice(idx, 1);
  }
  return ordered;
}

function toWorkoutSuggestion(session: PlannedWorkoutSession): WorkoutSuggestion {
  return {
    title: session.title,
    focus: session.focus,
    estimatedMinutes: session.estimatedMinutes,
    exercises: session.exercises.map((e) => ({
      name: e.name,
      sets: e.sets ?? 3,
      reps: String(e.reps ?? "10"),
      phase: e.phase ?? "main",
    })),
  };
}

function buildWeeklyWorkoutPlan(
  date: ISODate,
  profile: UserProfile,
  now = Date.now(),
): WorkoutPlan {
  const { start, end } = weekBounds(date);
  const trainingDayCount = profile.trainingDaysPerWeek ?? 3;
  const trainingDays = new Set(trainingDayIndexes(trainingDayCount));
  // Blend the user's preferred styles (or the balanced default), ordered so
  // overlapping areas never land on consecutive training days. Entries fill
  // training days in calendar order; rest days default to a yoga/deep-stretch
  // session so flexibility work continues even on off days.
  const blend = balancedTrainingBlend(trainingDays.size, profile.preferredWorkoutStyles ?? []);
  let trainingIndex = 0;
  const plannedSessions: PlannedWorkoutSession[] = Array.from({ length: 7 }, (_, i) => {
    const template = trainingDays.has(i)
      ? blend[trainingIndex++ % blend.length]
      : TEMPLATES.recoveryYoga;
    // Expand each day into the full arc: warm-up → main → core → cooldown.
    const session = composeSession(template);
    return {
      date: addDaysISO(start, i),
      title: session.title,
      focus: session.focus,
      estimatedMinutes: session.estimatedMinutes,
      exercises: session.exercises,
    };
  });

  return {
    id: `workout-week-${start}-${newId("plan")}`,
    createdAt: now,
    status: "active",
    generatedBy: "ai",
    planVersion: WORKOUT_PLAN_VERSION,
    weekStartDate: start,
    weekEndDate: end,
    plannedSessions,
    exercises: plannedSessions.flatMap((s) => s.exercises),
    goalAlignment: `Weekly plan for ${start} through ${end}; ${trainingDays.size} training day(s) blending strength, calisthenics, and yoga, with yoga/deep-stretch on recovery days for flexibility.`,
    activatedAt: now,
  };
}

export async function getOrCreateWeeklyWorkout(
  date: ISODate,
  profile: UserProfile,
): Promise<{
  plan: WorkoutPlan;
  workout: WorkoutSuggestion;
}> {
  const { start, end } = weekBounds(date);
  const store = await loadWorkoutPlansImpl();
  const existing = (store.plans || []).find(
    (p) =>
      !p.deletedAt &&
      p.status === "active" &&
      p.weekStartDate === start &&
      p.weekEndDate === end &&
      p.plannedSessions?.length &&
      (p.planVersion ?? 1) >= WORKOUT_PLAN_VERSION,
  );

  if (existing?.plannedSessions?.length) {
    const session =
      existing.plannedSessions.find((s) => s.date === date) || existing.plannedSessions[0];
    return { plan: existing, workout: toWorkoutSuggestion(session) };
  }

  const now = Date.now();
  const plan = buildWeeklyWorkoutPlan(date, profile, now);
  const plans = (store.plans || []).map((p) =>
    p.status === "active" && !p.deletedAt
      ? { ...p, status: "archived" as const, archivedAt: now, updatedAt: now }
      : p,
  );
  await saveWorkoutPlansImpl({ plans: [...plans, plan] });
  const session = plan.plannedSessions?.find((s) => s.date === date) || plan.plannedSessions![0];
  return { plan, workout: toWorkoutSuggestion(session) };
}
