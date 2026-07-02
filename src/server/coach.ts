/**
 * AI Coach — cross-domain suggestion + planning engine.
 *
 * One server module that acts as the user's "advisory board": a life coach,
 * personal trainer, and financial advisor rolled into structured, actionable
 * output. Powers:
 *   - "AI Suggestions" on the daily dashboard (focus / nutrition / finance / family)
 *   - "Workout Suggestions" (an AI-generated session for today)
 *   - A short motivational headline
 *
 * Design goals (AGENTS.md):
 *   - Actionable, not just descriptive.
 *   - Data-driven: suggestions reference the day's actual numbers.
 *   - Works with ZERO config — a deterministic fallback produces real,
 *     useful coaching when no GROK_API_KEY is present.
 */

import { createServerFn } from "@tanstack/react-start";
import type {
  ExercisePhase,
  ISODate,
  ISOWeek,
  PlannedWorkoutSession,
  UserProfile,
  WorkoutPlan,
  WorkoutStyle,
} from "@/lib/domain";
import {
  todayISO,
  addDaysISO,
  computeAge,
  createProductivityTask,
  cmToInches,
  mlToFlOz,
  newId,
} from "@/lib/domain";
import {
  loadDailyDashboardImpl,
  saveDailyPlanImpl,
  loadDailyPlanImpl,
  loadDailyNutritionImpl,
  loadProductivityTasksForDayImpl,
  saveProductivityTasksForDayImpl,
  loadDailyFinanceImpl,
  loadTransactionsImpl,
  loadWorkoutSessionsImpl,
  loadWorkoutPlansImpl,
  saveWorkoutPlansImpl,
  loadUserProfileImpl,
  estimateMacrosFromText,
} from "@/server/domain-impl";
import { requireAuthSession } from "@/lib/auth";
import { completeJSON, getGrokApiKey } from "@/server/adapters/ai";

export type CoachDomain = "focus" | "fitness" | "nutrition" | "finance" | "family" | "general";

export interface CoachSuggestion {
  domain: CoachDomain;
  /** The actionable recommendation (one sentence). */
  text: string;
  /** Optional voice/quick-command hint the user can act on immediately. */
  action?: string;
}

export interface WorkoutSuggestion {
  title: string;
  focus: string;
  estimatedMinutes: number;
  exercises: { name: string; sets: number; reps: string; phase?: ExercisePhase }[];
}

export interface CoachingResult {
  date: ISODate;
  /** Short motivational, data-aware one-liner. */
  headline: string;
  suggestions: CoachSuggestion[];
  workout: WorkoutSuggestion;
  generatedBy: "ai" | "fallback";
  updatedAt: number;
}

/** Snapshot of the day's numbers the coach reasons over. */
interface DaySignals {
  date: ISODate;
  tasksTotal: number;
  tasksDone: number;
  proteinCurrent: number;
  proteinTarget: number;
  waterMl: number;
  netWorth: number;
  hasFinance: boolean;
  mealsLogged: number;
  dayOfWeek: number; // 0 = Sun
}

async function collectSignals(date: ISODate, profile: UserProfile): Promise<DaySignals> {
  const dash = await loadDailyDashboardImpl(date);
  const tasks = (dash.productivity?.tasks || []).filter((t) => !t.deletedAt);
  const tasksDone = tasks.filter((t) => t.done).length;
  // Target precedence: the day's explicit plan target > the user's profile target > 150g default.
  const proteinTarget = dash.plan?.nutritionTargets?.protein ?? profile.proteinTargetG ?? 150;
  return {
    date,
    tasksTotal: tasks.length,
    tasksDone,
    proteinCurrent: dash.nutrition?.totals?.protein ?? 0,
    proteinTarget,
    waterMl: dash.nutrition?.waterMl ?? 0,
    netWorth: dash.finance?.netWorth ?? 0,
    hasFinance: !!dash.finance && (dash.finance.accounts.length > 0 || dash.finance.netWorth > 0),
    mealsLogged: dash.nutrition?.mealLogs?.length ?? 0,
    dayOfWeek: new Date(date + "T00:00:00").getDay(),
  };
}

/* ============================================================
   TRAILING 7-DAY TREND (ADR-013)
   Lets the coach reference momentum, not just today's snapshot.
   Uses the lighter per-domain loaders (no per-day jsonl reads).
   ============================================================ */

export interface TrendSignals {
  /** Number of calendar days in the window (inclusive of `date`). */
  days: number;
  /** Days with any logged activity (meal, task, or finance). */
  activeDays: number;
  /** Window-wide task completion: sum(done) / sum(total). */
  taskCompletionPct: number;
  /** Average daily protein as a % of target across days that logged any food. */
  avgProteinPct: number;
  /** Days that hit ≥90% of the protein target. */
  proteinDaysOnTarget: number;
  /** Average daily water (ml) across days that logged any food; displayed as fl oz. */
  avgWaterMl: number;
  /** Workout sessions performed within the window. */
  workouts: number;
  /** Net-worth change (latest − earliest non-zero) across the window. */
  netWorthChange: number;
  /** Net cashflow from manually logged transactions across the window. */
  netCashflow: number;
  /** Protein direction: second-half average vs first-half average. */
  proteinTrend: "up" | "down" | "flat";
}

/** Build the list of ISO dates for a trailing window ending on `date` (inclusive). */
function trailingDates(date: ISODate, days: number): ISODate[] {
  const out: ISODate[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(addDaysISO(date, -i));
  }
  return out;
}

export async function collectTrend(
  date: ISODate,
  proteinTarget: number,
  days = 7,
): Promise<TrendSignals> {
  const dates = trailingDates(date, days);

  const [nutritionByDay, tasksByDay, financeByDay, sessionsStore, transactionsStore] =
    await Promise.all([
      Promise.all(dates.map((d) => loadDailyNutritionImpl(d))),
      Promise.all(dates.map((d) => loadProductivityTasksForDayImpl(d))),
      Promise.all(dates.map((d) => loadDailyFinanceImpl(d))),
      loadWorkoutSessionsImpl(),
      loadTransactionsImpl(),
    ]);

  let activeDays = 0;
  let tasksDone = 0;
  let tasksTotal = 0;
  const proteinPctByDay: number[] = [];
  let waterSum = 0;
  let waterDays = 0;

  dates.forEach((_, i) => {
    const meals = (nutritionByDay[i]?.mealLogs || []).filter((m) => !m.deletedAt);
    const tasks = (tasksByDay[i]?.tasks || []).filter((t) => !t.deletedAt);
    const netWorth = financeByDay[i]?.netWorth ?? 0;
    const logged = meals.length > 0 || tasks.length > 0 || netWorth > 0;
    if (logged) activeDays++;

    tasksDone += tasks.filter((t) => t.done).length;
    tasksTotal += tasks.length;

    if (meals.length > 0) {
      const protein = nutritionByDay[i]?.totals?.protein ?? 0;
      proteinPctByDay.push(proteinTarget > 0 ? (protein / proteinTarget) * 100 : 0);
      waterSum += nutritionByDay[i]?.waterMl ?? 0;
      waterDays++;
    }
  });

  const windowStart = new Date(dates[0] + "T00:00:00").getTime();
  const windowEnd = new Date(dates[dates.length - 1] + "T23:59:59.999").getTime();
  const workouts = (sessionsStore?.sessions || []).filter(
    (s) => !s.deletedAt && s.performedAt >= windowStart && s.performedAt <= windowEnd,
  ).length;

  // Net-worth change: latest minus earliest non-zero reading in the window.
  const netWorths = financeByDay.map((f) => f?.netWorth ?? 0);
  const firstNonZero = netWorths.find((n) => n > 0) ?? 0;
  const lastNonZero = [...netWorths].reverse().find((n) => n > 0) ?? 0;
  const netWorthChange = lastNonZero - firstNonZero;
  const netCashflow = (transactionsStore?.transactions || [])
    .filter((t) => !t.deletedAt && t.timestamp >= windowStart && t.timestamp <= windowEnd)
    .reduce((sum, t) => sum + t.amount, 0);

  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const half = Math.floor(proteinPctByDay.length / 2);
  const firstHalf = avg(proteinPctByDay.slice(0, half));
  const secondHalf = avg(proteinPctByDay.slice(half));
  const delta = secondHalf - firstHalf;
  const proteinTrend: TrendSignals["proteinTrend"] =
    proteinPctByDay.length < 2 || Math.abs(delta) < 5 ? "flat" : delta > 0 ? "up" : "down";

  return {
    days,
    activeDays,
    taskCompletionPct: tasksTotal > 0 ? Math.round((tasksDone / tasksTotal) * 100) : 0,
    avgProteinPct: Math.round(avg(proteinPctByDay)),
    proteinDaysOnTarget: proteinPctByDay.filter((p) => p >= 90).length,
    avgWaterMl: waterDays > 0 ? Math.round(waterSum / waterDays) : 0,
    workouts,
    netWorthChange,
    netCashflow,
    proteinTrend,
  };
}

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
      { name: "Warrior I → II → reverse warrior", sets: 2, reps: "5 breaths/side" },
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
    { name: "Jump rope or arm circles", sets: 1, reps: "3 min", phase: "warmup" },
    { name: "Band pull-aparts", sets: 2, reps: "15", phase: "warmup" },
    { name: "Scapular push-ups + cat-cow", sets: 2, reps: "10", phase: "warmup" },
  ],
  lower: [
    { name: "Easy bike or brisk walk", sets: 1, reps: "3 min", phase: "warmup" },
    { name: "Leg swings (front + side)", sets: 1, reps: "10/leg", phase: "warmup" },
    { name: "Bodyweight squats + hip circles", sets: 2, reps: "12", phase: "warmup" },
  ],
  general: [
    { name: "Easy row or bike", sets: 1, reps: "4 min", phase: "warmup" },
    { name: "Dynamic leg swings + arm circles", sets: 1, reps: "10 each", phase: "warmup" },
    { name: "World's greatest stretch", sets: 1, reps: "5/side", phase: "warmup" },
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
    { name: "Doorway chest stretch", sets: 1, reps: "45s/side", phase: "cooldown" },
    { name: "Cross-body shoulder + triceps stretch", sets: 1, reps: "30s/side", phase: "cooldown" },
    { name: "Child's pose", sets: 1, reps: "60s", phase: "cooldown" },
  ],
  lower: [
    { name: "Standing quad stretch", sets: 1, reps: "45s/side", phase: "cooldown" },
    { name: "Seated hamstring forward fold", sets: 1, reps: "60s", phase: "cooldown" },
    { name: "Figure-4 glute stretch", sets: 1, reps: "45s/side", phase: "cooldown" },
  ],
  general: [
    { name: "Standing forward fold", sets: 1, reps: "60s", phase: "cooldown" },
    { name: "Supine spinal twist", sets: 1, reps: "45s/side", phase: "cooldown" },
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

function fallbackWorkout(signals: DaySignals): WorkoutSuggestion {
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
  return composeSession(byDay[signals.dayOfWeek] ?? TEMPLATES.push);
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

async function getOrCreateWeeklyWorkout(
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

/* ============================================================
   DETERMINISTIC FALLBACK COACH (no API key needed)
   ============================================================ */

function fallbackCoaching(
  signals: DaySignals,
  profile: UserProfile,
  trend: TrendSignals,
  plannedWorkout?: WorkoutSuggestion,
): CoachingResult {
  const suggestions: CoachSuggestion[] = [];
  const waterTarget = profile.waterTargetMl ?? 2500;
  const waterCurrentOz = mlToFlOz(signals.waterMl) ?? 0;
  const waterTargetOz = mlToFlOz(waterTarget) ?? 85;

  // FOCUS / PRODUCTIVITY
  if (signals.tasksTotal === 0) {
    suggestions.push({
      domain: "focus",
      text: "No tasks yet today — name your top 3 outcomes so the day has direction.",
      action: "add task ",
    });
  } else if (signals.tasksDone === 0) {
    suggestions.push({
      domain: "focus",
      text: `You have ${signals.tasksTotal} task(s) queued. Knock out the smallest one first to build momentum.`,
    });
  } else if (signals.tasksDone < signals.tasksTotal) {
    suggestions.push({
      domain: "focus",
      text: `${signals.tasksDone}/${signals.tasksTotal} done — protect a 25-min focus block to clear one more.`,
    });
  } else {
    suggestions.push({
      domain: "focus",
      text: "All tasks complete. Bank the win and set tomorrow’s top priority tonight.",
    });
  }

  // NUTRITION (trainer + dietitian)
  const proteinGap = signals.proteinTarget - signals.proteinCurrent;
  if (proteinGap > 0) {
    suggestions.push({
      domain: "nutrition",
      text: `Protein is ${signals.proteinCurrent}g of ${signals.proteinTarget}g — ${proteinGap}g to go. A lean meat, Greek yogurt, or shake closes the gap.`,
      action: "log 40g protein ",
    });
  } else {
    suggestions.push({
      domain: "nutrition",
      text: `Protein target hit (${signals.proteinCurrent}g). Keep portions steady and prioritize whole foods.`,
    });
  }
  if (signals.waterMl < waterTarget) {
    suggestions.push({
      domain: "nutrition",
      text: `Hydration at ${waterCurrentOz} fl oz — aim for ~${waterTargetOz} fl oz. Grab a glass now.`,
      action: "add water 12 oz",
    });
  }

  // FITNESS
  const w = plannedWorkout ?? fallbackWorkout(signals);
  const weeklyTarget = profile.trainingDaysPerWeek ?? 3;
  const injuryNote = profile.injuries?.length
    ? ` Work around your ${profile.injuries.join(" / ")} — swap any movement that aggravates it.`
    : "";
  const fitnessText =
    trend.workouts < weeklyTarget
      ? `${trend.workouts}/${weeklyTarget} workouts this week — today's suggested session: ${w.title} (~${w.estimatedMinutes} min). Schedule it before the day fills up.${injuryNote}`
      : `You've hit ${trend.workouts} workouts this week. Today: ${w.title} (~${w.estimatedMinutes} min) or active recovery if you're sore.${injuryNote}`;
  suggestions.push({
    domain: "fitness",
    text: fitnessText,
    action: "add workout " + w.estimatedMinutes + " min",
  });

  // FINANCE (advisor)
  if (!signals.hasFinance) {
    suggestions.push({
      domain: "finance",
      text: "Add your account balances to start a net-worth baseline — you can’t improve what you don’t measure.",
    });
  } else {
    const trendNote =
      trend.netWorthChange !== 0
        ? ` Net worth is ${trend.netWorthChange > 0 ? "up" : "down"} $${Math.abs(trend.netWorthChange).toLocaleString()} over the last ${trend.days} days.`
        : "";
    const cashflowNote =
      trend.netCashflow !== 0
        ? ` Logged net cashflow is ${trend.netCashflow > 0 ? "+" : "-"}$${Math.abs(trend.netCashflow).toLocaleString()} this week.`
        : "";
    const savingsNote = profile.monthlySavingsGoal
      ? ` Toward your $${profile.monthlySavingsGoal.toLocaleString()}/mo savings goal, automate one transfer now.`
      : " Automate one transfer to savings/investments this week and review recurring subscriptions.";
    suggestions.push({
      domain: "finance",
      text: `Net worth tracked at $${signals.netWorth.toLocaleString()}.${trendNote}${cashflowNote}${savingsNote}`,
    });
  }

  // FAMILY / LIFE
  suggestions.push({
    domain: "family",
    text: "Block 20 distraction-free minutes with family today — presence compounds more than productivity.",
    action: "add family time 20 min",
  });

  // MOMENTUM (trend-aware, general)
  if (trend.activeDays >= 2) {
    const momentum =
      trend.proteinTrend === "down"
        ? `Heads up: protein is trending down this week (avg ${trend.avgProteinPct}% of target). Front-load it at breakfast tomorrow.`
        : trend.taskCompletionPct >= 70
          ? `Strong week — ${trend.taskCompletionPct}% task completion across ${trend.activeDays} active days. Protect what's working.`
          : `You've shown up ${trend.activeDays}/${trend.days} days. Consistency beats intensity — keep the streak alive.`;
    suggestions.push({ domain: "general", text: momentum });
  }

  // HEADLINE
  const pct =
    signals.tasksTotal > 0 ? Math.round((signals.tasksDone / signals.tasksTotal) * 100) : 0;
  const who = profile.displayName ? `${profile.displayName}, ` : "";
  const headline =
    signals.tasksTotal === 0
      ? `${who}fresh start — set your intentions and the rest follows.`
      : pct >= 100
        ? "Clean sweep on tasks. Recover well and keep the streak alive."
        : pct >= 50
          ? `Solid momentum — ${pct}% through your tasks. Finish strong.`
          : "Early in the day. One focused block changes everything.";

  return {
    date: signals.date,
    headline,
    suggestions,
    workout: w,
    generatedBy: "fallback",
    updatedAt: Date.now(),
  };
}

/* ============================================================
   GROK-BACKED COACH
   ============================================================ */

export function profileBlock(profile: UserProfile): string {
  const lines: string[] = [];
  const age = computeAge(profile.birthDate);
  const heightIn = cmToInches(profile.heightCm);
  const heightLabel =
    typeof heightIn === "number" ? `${Math.floor(heightIn / 12)}'${heightIn % 12}"` : null;
  const bio = [
    age ? `${age}y` : null,
    profile.sex,
    heightLabel,
    profile.units ? `units: ${profile.units}` : "units: imperial",
    profile.activityLevel ? `activity: ${profile.activityLevel}` : null,
  ].filter(Boolean);
  if (bio.length) lines.push(`- Bio: ${bio.join(", ")}`);
  if (profile.goals?.length) lines.push(`- Goals: ${profile.goals.join("; ")}`);
  if (profile.injuries?.length)
    lines.push(`- Injuries/limits (MUST respect): ${profile.injuries.join(", ")}`);
  if (profile.equipmentAccess?.length)
    lines.push(`- Equipment: ${profile.equipmentAccess.join(", ")}`);
  if (profile.trainingDaysPerWeek)
    lines.push(`- Target training days/week: ${profile.trainingDaysPerWeek}`);
  if (profile.preferredWorkoutStyles?.length)
    lines.push(
      `- Preferred workout styles (emphasize these): ${profile.preferredWorkoutStyles.join(", ")}`,
    );
  if (profile.dietaryRestrictions?.length)
    lines.push(`- Dietary restrictions (MUST respect): ${profile.dietaryRestrictions.join(", ")}`);
  if (profile.riskTolerance) lines.push(`- Investing risk tolerance: ${profile.riskTolerance}`);
  if (profile.monthlySavingsGoal)
    lines.push(`- Monthly savings goal: $${profile.monthlySavingsGoal}`);
  if (profile.financeNotes) lines.push(`- Finance notes: ${profile.financeNotes}`);
  return lines.length
    ? lines.join("\n")
    : "- (no profile set — give solid general guidance and suggest filling out a profile)";
}

function buildCoachPrompt(
  signals: DaySignals,
  profile: UserProfile,
  trend: TrendSignals,
  plannedWorkout: WorkoutSuggestion,
): string {
  const name = profile.displayName || "Brian";
  const waterOz = mlToFlOz(signals.waterMl) ?? 0;
  const avgWaterOz = mlToFlOz(trend.avgWaterMl) ?? 0;
  return `You are ${name}'s personal advisory board: an elite life coach, a certified strength & conditioning coach, and a CFP-level financial advisor. Give concise, actionable coaching for TODAY based on real data. Personalize every suggestion to the profile and the 7-day trend — never contradict injuries or dietary restrictions.

User profile:
${profileBlock(profile)}

Today's data (${signals.date}, weekday index ${signals.dayOfWeek} where 0=Sunday):
- Tasks: ${signals.tasksDone}/${signals.tasksTotal} complete
- Protein: ${signals.proteinCurrent}g of ${signals.proteinTarget}g target
- Water: ${waterOz} fl oz
- Meals logged: ${signals.mealsLogged}
- Net worth tracked: ${signals.hasFinance ? "$" + signals.netWorth : "not set up yet"}

Last ${trend.days} days (trend):
- Active days: ${trend.activeDays}/${trend.days}
- Task completion: ${trend.taskCompletionPct}%
- Workouts: ${trend.workouts}
- Avg protein: ${trend.avgProteinPct}% of target (direction: ${trend.proteinTrend}); ${trend.proteinDaysOnTarget} day(s) on target
- Avg water: ${avgWaterOz} fl oz
- Net-worth change: ${trend.netWorthChange >= 0 ? "+" : ""}$${trend.netWorthChange}
- Net cashflow from logged transactions: ${trend.netCashflow >= 0 ? "+" : ""}$${trend.netCashflow}

This week's workout plan assigns TODAY:
- ${plannedWorkout.title} (${plannedWorkout.focus}, ~${plannedWorkout.estimatedMinutes} min)
- Structured warm-up → main → core → cooldown stretch:
${plannedWorkout.exercises
  .map((e) => `  [${e.phase ?? "main"}] ${e.name} ${e.sets}x${e.reps}`)
  .join("\n")}

Reply with ONLY one compact JSON object (no markdown):
{
  "headline": "short motivational, data-aware one-liner",
  "suggestions": [
    { "domain": "focus|fitness|nutrition|finance|family|general", "text": "one actionable sentence", "action": "optional voice command e.g. 'log 40g protein'" }
  ],
  "workout": {
    "title": "session name",
    "focus": "muscle group / goal",
    "estimatedMinutes": number,
    "exercises": [ { "name": "Exercise", "sets": number, "reps": "8-10" } ]
  }
}

Rules:
- 4 to 6 suggestions, one per domain where relevant, each referencing his actual numbers.
- Use US customary units for bodyweight, exercise loads, height, and hydration (lb, in, fl oz), not kg/cm/ml in user-facing text.
- The workout must be the assigned weekly-plan session above; do not invent a different session. Every session already runs a warm-up first and finishes with a core block and cooldown stretch — reinforce not skipping the warm-up or cooldown.
- His program intentionally blends traditional strength, bodyweight calisthenics, and yoga across the week; the fitness suggestion should reinforce building BOTH strength and flexibility/mobility (not strength alone).
- Be specific and encouraging. No fluff, no disclaimers.`;
}

async function aiCoaching(
  signals: DaySignals,
  profile: UserProfile,
  trend: TrendSignals,
  apiKey: string,
  plannedWorkout: WorkoutSuggestion,
): Promise<CoachingResult> {
  const parsed = await completeJSON<any>(apiKey, {
    model: "grok-3-mini",
    messages: [
      { role: "system", content: "Return strictly valid minified JSON only. No prose." },
      { role: "user", content: buildCoachPrompt(signals, profile, trend, plannedWorkout) },
    ],
    temperature: 0.5,
    maxTokens: 700,
  });

  const workout = plannedWorkout;
  const fbCoaching = fallbackCoaching(signals, profile, trend, plannedWorkout);
  const suggestions: CoachSuggestion[] = Array.isArray(parsed.suggestions)
    ? parsed.suggestions.slice(0, 6).map((s: any) => ({
        domain: (s.domain || "general") as CoachDomain,
        text: String(s.text || "").trim(),
        action: s.action ? String(s.action) : undefined,
      }))
    : fbCoaching.suggestions;

  return {
    date: signals.date,
    headline: String(parsed.headline || fbCoaching.headline),
    suggestions: suggestions.filter((s) => s.text),
    workout,
    generatedBy: "ai",
    updatedAt: Date.now(),
  };
}

/* ============================================================
   PUBLIC SERVER FN
   ============================================================ */

/**
 * Generate (and persist) coaching for a date. Persists the suggestion text +
 * workout summary into the DailyPlan so the dashboard renders instantly on
 * reload without re-calling the LLM.
 */
export const generateCoaching = createServerFn({ method: "POST" })
  .validator((data: { date?: ISODate; force?: boolean }) => data)
  .handler(async (ctx: any): Promise<CoachingResult> => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    const date = data.date || todayISO();
    const existing = await loadDailyPlanImpl(date);
    if (!data.force && existing?.aiCoaching) {
      return {
        date,
        headline: existing.aiCoaching.headline,
        suggestions: existing.aiCoaching.suggestions,
        workout: existing.aiCoaching.workout,
        generatedBy: existing.aiCoaching.generatedBy,
        updatedAt: existing.aiCoaching.updatedAt,
      };
    }

    const profile = await loadUserProfileImpl();
    const signals = await collectSignals(date, profile);
    const trend = await collectTrend(date, signals.proteinTarget);
    const weeklyWorkout = await getOrCreateWeeklyWorkout(date, profile);

    let result: CoachingResult;
    const apiKey = await getGrokApiKey();
    if (apiKey) {
      try {
        result = await aiCoaching(signals, profile, trend, apiKey, weeklyWorkout.workout);
      } catch (e) {
        console.warn("[coach] Grok coaching failed, using fallback", e);
        result = fallbackCoaching(signals, profile, trend, weeklyWorkout.workout);
      }
    } else {
      result = fallbackCoaching(signals, profile, trend, weeklyWorkout.workout);
    }

    // Persist into the DailyPlan so reloads are free.
    try {
      await saveDailyPlanImpl({
        id: existing?.id || `plan-${date}`,
        createdAt: existing?.createdAt || Date.now(),
        date,
        topTaskIds: existing?.topTaskIds || [],
        workoutPlanId: weeklyWorkout.plan.id,
        nutritionTargets: existing?.nutritionTargets ?? { protein: signals.proteinTarget },
        voiceNoteIds: existing?.voiceNoteIds,
        notes: existing?.notes,
        acceptedAt: existing?.acceptedAt,
        acceptedSuggestionIds: existing?.acceptedSuggestionIds,
        aiSuggestions: result.suggestions.map(
          (s) => `[${s.domain}] ${s.text}` + (s.action ? `  (try: "${s.action}")` : ""),
        ),
        aiCoaching: {
          headline: result.headline,
          suggestions: result.suggestions,
          workout: result.workout,
          generatedBy: result.generatedBy,
          updatedAt: result.updatedAt,
        },
      });
    } catch (e) {
      console.warn("[coach] failed to persist suggestions to DailyPlan", e);
    }

    return result;
  });

/**
 * Return the active weekly workout plan for the week containing `date`,
 * building (and persisting) one from the user's profile if none exists yet.
 * No LLM call — pure template composition — so the Workouts page can rely on
 * a structured plan being present without paying for coaching generation.
 */
export const ensureWeeklyWorkoutPlan = createServerFn({ method: "POST" })
  .validator((data: { date?: ISODate }) => data)
  .handler(async (ctx: any): Promise<{ plan: WorkoutPlan }> => {
    await requireAuthSession(ctx.request);
    const date = ctx.data?.date || todayISO();
    const profile = await loadUserProfileImpl();
    const { plan } = await getOrCreateWeeklyWorkout(date, profile);
    return { plan };
  });

export const acceptDailyCoachingPlan = createServerFn({ method: "POST" })
  .validator(
    (data: { date: ISODate; suggestions: CoachSuggestion[]; workout: WorkoutSuggestion }) => data,
  )
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    const now = Date.now();
    const existingTasks = await loadProductivityTasksForDayImpl(data.date);

    const planTasks = (data.suggestions as CoachSuggestion[])
      .filter((s: CoachSuggestion) => s.text && s.domain !== "general")
      .slice(0, 5)
      .map((s: CoachSuggestion) =>
        createProductivityTask({
          text: `${domainLabel(s.domain)}: ${s.text}`,
          date: data.date,
          tags: [s.domain, "coach-plan"],
          source: "ai",
          priority: s.domain === "focus" || s.domain === "fitness" ? 1 : 2,
        }),
      );

    const workoutTask = createProductivityTask({
      text: `Workout: ${data.workout.title} (${data.workout.estimatedMinutes} min)`,
      date: data.date,
      tags: ["fitness", "coach-plan"],
      estimatedMinutes: data.workout.estimatedMinutes,
      source: "ai",
      priority: 1,
    });

    const tasks = [...(existingTasks?.tasks || []), workoutTask, ...planTasks];
    await saveProductivityTasksForDayImpl({ date: data.date, tasks });

    const existingPlan = await loadDailyPlanImpl(data.date);
    const plan = await saveDailyPlanImpl({
      id: existingPlan?.id || `plan-${data.date}`,
      createdAt: existingPlan?.createdAt || now,
      date: data.date,
      workoutPlanId: existingPlan?.workoutPlanId,
      nutritionTargets: existingPlan?.nutritionTargets,
      topTaskIds: [workoutTask.id, ...planTasks.slice(0, 3).map((t) => t.id)],
      acceptedAt: now,
      acceptedSuggestionIds: planTasks.map((t) => t.id),
      aiSuggestions:
        existingPlan?.aiSuggestions ||
        (data.suggestions as CoachSuggestion[]).map(
          (s: CoachSuggestion) => `[${s.domain}] ${s.text}`,
        ),
      aiCoaching: existingPlan?.aiCoaching,
      voiceNoteIds: existingPlan?.voiceNoteIds,
      notes: existingPlan?.notes,
    });

    return { plan, tasksAdded: [workoutTask, ...planTasks] };
  });

function domainLabel(domain: CoachDomain): string {
  return domain.charAt(0).toUpperCase() + domain.slice(1);
}

/* ============================================================
   WEEKLY REVIEW NARRATIVE (life coach)
   ============================================================ */

export interface WeeklyStatsInput {
  week: ISOWeek;
  tasksCompleted: number;
  tasksTotal: number;
  workouts: number;
  avgProteinPct: number;
  avgWaterMl: number;
  netWorth: number;
  activeDays: number;
}

export interface WeeklyNarrativeResult {
  week: ISOWeek;
  reflection: string;
  wins: string[];
  blockers: string[];
  nextWeekFocus: string[];
  generatedBy: "ai" | "fallback";
}

function fallbackWeekly(s: WeeklyStatsInput): WeeklyNarrativeResult {
  const completion = s.tasksTotal > 0 ? Math.round((s.tasksCompleted / s.tasksTotal) * 100) : 0;
  const wins: string[] = [];
  const blockers: string[] = [];
  const nextWeekFocus: string[] = [];

  if (s.tasksCompleted > 0)
    wins.push(`Completed ${s.tasksCompleted} task(s) (${completion}% of planned).`);
  if (s.workouts > 0) wins.push(`Trained ${s.workouts} time(s) this week.`);
  if (s.avgProteinPct >= 90)
    wins.push(`Strong protein intake (${s.avgProteinPct}% of target on average).`);
  if (s.activeDays >= 5) wins.push(`Logged activity on ${s.activeDays} days — great consistency.`);
  if (wins.length === 0) wins.push("Showed up — every logged day is a foundation to build on.");

  if (completion < 60 && s.tasksTotal > 0)
    blockers.push(
      `Task completion at ${completion}% — likely over-committed or too many context switches.`,
    );
  if (s.workouts < 3) blockers.push(`Only ${s.workouts} workout(s) — aim for at least 3 sessions.`);
  if (s.avgProteinPct < 80)
    blockers.push(
      `Protein averaged ${s.avgProteinPct}% of target — front-load protein at breakfast.`,
    );
  if (s.activeDays < 4)
    blockers.push(`Active only ${s.activeDays} days — a 30-second daily check-in keeps momentum.`);

  if (s.workouts < 3)
    nextWeekFocus.push("Schedule 3–4 workouts in advance and treat them as appointments.");
  nextWeekFocus.push(
    "Pick the 3 outcomes that matter most each morning before opening anything else.",
  );
  if (s.avgProteinPct < 90)
    nextWeekFocus.push("Hit a protein target every day — prep two high-protein staples.");
  if (s.netWorth > 0)
    nextWeekFocus.push("Review one recurring expense and automate one savings transfer.");

  const reflection =
    `This week you completed ${s.tasksCompleted}/${s.tasksTotal} tasks (${completion}%), trained ${s.workouts} time(s), ` +
    `and averaged ${s.avgProteinPct}% of your protein target across ${s.activeDays} active day(s). ` +
    (completion >= 70
      ? "Momentum is real — protect what’s working and add one small stretch goal."
      : "Tighten focus next week: fewer commitments, finished fully, beats many started.");

  return { week: s.week, reflection, wins, blockers, nextWeekFocus, generatedBy: "fallback" };
}

export const generateWeeklyNarrative = createServerFn({ method: "POST" })
  .validator((data: WeeklyStatsInput) => data)
  .handler(async (ctx: any): Promise<WeeklyNarrativeResult> => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    const apiKey = await getGrokApiKey();
    if (!apiKey) return fallbackWeekly(data);
    const profile = await loadUserProfileImpl();

    const completion =
      data.tasksTotal > 0 ? Math.round((data.tasksCompleted / data.tasksTotal) * 100) : 0;
    const avgWaterOz = mlToFlOz(data.avgWaterMl) ?? 0;
    const prompt = `You are Brian's life coach + strength coach + financial advisor writing his WEEKLY REVIEW for ${data.week}.

Data this week:
- Tasks: ${data.tasksCompleted}/${data.tasksTotal} complete (${completion}%)
- Workouts: ${data.workouts}
- Avg protein vs target: ${data.avgProteinPct}%
- Avg water: ${avgWaterOz} fl oz
- Net worth: ${data.netWorth > 0 ? "$" + data.netWorth : "not tracked"}
- Active (logged) days: ${data.activeDays}/7

User profile:
${profileBlock(profile)}

Reply with ONLY one compact JSON object:
{ "reflection": "2-3 sentence honest, encouraging summary", "wins": ["..."], "blockers": ["..."], "nextWeekFocus": ["..."] }
Each array has 2-4 specific, actionable items referencing the numbers. Use US customary units for bodyweight, exercise loads, height, and hydration. No markdown.`;

    try {
      const parsed = await completeJSON<any>(apiKey, {
        model: "grok-3-mini",
        messages: [
          { role: "system", content: "Return strictly valid minified JSON only. No prose." },
          { role: "user", content: prompt },
        ],
        temperature: 0.5,
        maxTokens: 600,
      });
      const arr = (v: any): string[] =>
        Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 4) : [];
      const fb = fallbackWeekly(data);
      return {
        week: data.week,
        reflection: String(parsed.reflection || fb.reflection),
        wins: arr(parsed.wins).length ? arr(parsed.wins) : fb.wins,
        blockers: arr(parsed.blockers).length ? arr(parsed.blockers) : fb.blockers,
        nextWeekFocus: arr(parsed.nextWeekFocus).length
          ? arr(parsed.nextWeekFocus)
          : fb.nextWeekFocus,
        generatedBy: "ai",
      };
    } catch (e) {
      console.warn("[coach] weekly narrative failed, using fallback", e);
      return fallbackWeekly(data);
    }
  });

/* ============================================================
   FOOD MACRO LOOKUP (dietitian)
   Estimate calories + macros for a free-text food/meal so the user can
   log "chicken breast" or "2 eggs and toast" without knowing the numbers.
   Grok-backed with a deterministic fallback (parses any numbers in text).
   ============================================================ */

export interface FoodMacroEstimate {
  /** Cleaned-up food/meal name to store on the log. */
  name: string;
  /** Portion amount the macros describe. */
  quantity: number;
  unit: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  confidence: "low" | "medium" | "high";
  generatedBy: "ai" | "fallback";
}

/** Deterministic fallback — only recovers numbers the user typed. */
function fallbackFoodMacros(description: string): FoodMacroEstimate {
  const { macros, confidence } = estimateMacrosFromText(description);
  return {
    name: description.trim() || "Meal",
    quantity: 1,
    unit: "serving",
    calories: macros.calories,
    protein: macros.protein,
    carbs: macros.carbs,
    fat: macros.fat,
    confidence,
    generatedBy: "fallback",
  };
}

export const estimateFoodMacros = createServerFn({ method: "POST" })
  .validator((data: { description: string }) => data)
  .handler(async (ctx: any): Promise<FoodMacroEstimate> => {
    await requireAuthSession(ctx.request);
    const description = String(ctx.data?.description || "").trim();
    if (!description) {
      return fallbackFoodMacros("");
    }

    const apiKey = await getGrokApiKey();
    if (!apiKey) return fallbackFoodMacros(description);

    const prompt = `You are a precise nutrition database. Estimate the nutrition facts for the food or meal described below.
If the description includes a portion/quantity (e.g. "6 oz", "2 eggs", "1 cup"), estimate for that exact portion.
If the description does NOT include a portion, assume one realistic amount a person would log/eat for that food, not a per-100g database row.

Food: "${description}"

Reply with ONLY one compact JSON object, no markdown:
{ "name": "concise food name", "quantity": number, "unit": "serving|g|oz|cup|piece|slice", "calories": number, "protein": number, "carbs": number, "fat": number, "confidence": "low|medium|high" }

Rules:
- calories in kcal; protein, carbs, fat in grams — all for the TOTAL portion described.
- Use realistic USDA-style values. Never return all zeros for a real food.
- Do not undercount rich prepared foods by silently assuming a tiny portion.
- If uncertain, choose a plausible typical serving and set confidence to "low" or "medium".
- confidence reflects how identifiable the food is.`;

    try {
      const parsed = await completeJSON<any>(apiKey, {
        model: "grok-3-mini",
        messages: [
          { role: "system", content: "Return strictly valid minified JSON only. No prose." },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        maxTokens: 200,
      });

      const num = (v: any) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
      };
      const conf =
        parsed.confidence === "high" ||
        parsed.confidence === "medium" ||
        parsed.confidence === "low"
          ? parsed.confidence
          : "medium";
      const estimate: FoodMacroEstimate = {
        name:
          String(parsed.name || description)
            .trim()
            .slice(0, 80) || description,
        quantity: Number(parsed.quantity) > 0 ? Number(parsed.quantity) : 1,
        unit:
          String(parsed.unit || "serving")
            .trim()
            .slice(0, 16) || "serving",
        calories: num(parsed.calories),
        protein: num(parsed.protein),
        carbs: num(parsed.carbs),
        fat: num(parsed.fat),
        confidence: conf,
        generatedBy: "ai",
      };
      // If the model returned nothing usable, fall back to text parsing.
      if (
        estimate.calories === 0 &&
        estimate.protein === 0 &&
        estimate.carbs === 0 &&
        estimate.fat === 0
      ) {
        return fallbackFoodMacros(description);
      }
      return estimate;
    } catch (e) {
      console.warn("[coach] food macro estimate failed, using fallback", e);
      return fallbackFoodMacros(description);
    }
  });
