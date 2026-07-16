/** Coach Engine daily signals, AI generation, fallback, and DailyPlan persistence (ADR-011). */

import type { CoachMemory, ExercisePhase, ISODate, UserProfile, WorkoutPlan } from "@/lib/domain";
import {
  addDaysISO,
  cmToInches,
  computeAge,
  createProductivityTask,
  mlToFlOz,
  todayISO,
} from "@/lib/domain";
import {
  isAvoidedRecommendation,
  recommendationLearningBlock,
  summarizeRecommendationLearning,
  type RecommendationLearning,
} from "@/lib/recommendation-learning";
import { stableRecommendationId } from "@/lib/recommendation-id";
import {
  loadCoachMemoriesImpl,
  loadDailyDashboardImpl,
  loadDailyFinanceImpl,
  loadDailyNutritionImpl,
  loadDailyPlanImpl,
  loadProductivityTasksForDayImpl,
  loadTransactionsImpl,
  loadUserProfileImpl,
  loadWorkoutSessionsImpl,
  saveDailyPlanImpl,
  saveProductivityTasksForDayImpl,
} from "@/server/domain-impl";
import { completeJSON, getGrokApiKey, getGrokJsonModel } from "@/server/adapters/ai";
import {
  loadRecommendationOutcomesImpl,
  recordRecommendationOutcomeImpl,
} from "@/server/recommendation-outcomes-impl";
import { memoriesBlock } from "@/server/context";
import { fallbackWorkout, getOrCreateWeeklyWorkout } from "@/server/coach-workout-impl";

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
  exercises: {
    name: string;
    sets: number;
    reps: string;
    phase?: ExercisePhase;
  }[];
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

function emptyLearning(): RecommendationLearning {
  return {
    latest: [],
    completedTexts: [],
    helpfulTexts: [],
    notHelpfulTexts: [],
    dismissedTexts: [],
    snoozedTexts: [],
  };
}

async function loadRecentRecommendationLearning(
  date: ISODate,
  days = 14,
): Promise<RecommendationLearning> {
  const dates: ISODate[] = [];
  for (let i = 0; i < days; i++) dates.push(addDaysISO(date, -i));
  try {
    const outcomes = await loadRecommendationOutcomesImpl(dates);
    return summarizeRecommendationLearning(outcomes);
  } catch (e) {
    console.warn("[coach] failed to load recommendation outcomes", e);
    return emptyLearning();
  }
}

function pushSuggestion(
  suggestions: CoachSuggestion[],
  suggestion: CoachSuggestion,
  learning: RecommendationLearning,
) {
  if (isAvoidedRecommendation(suggestion.text, learning)) return;
  suggestions.push(suggestion);
}

function fallbackCoaching(
  signals: DaySignals,
  profile: UserProfile,
  trend: TrendSignals,
  plannedWorkout?: WorkoutSuggestion,
  learning: RecommendationLearning = emptyLearning(),
): CoachingResult {
  const suggestions: CoachSuggestion[] = [];
  const waterTarget = profile.waterTargetMl ?? 2500;
  const waterCurrentOz = mlToFlOz(signals.waterMl) ?? 0;
  const waterTargetOz = mlToFlOz(waterTarget) ?? 85;

  // FOCUS / PRODUCTIVITY
  if (signals.tasksTotal === 0) {
    pushSuggestion(
      suggestions,
      {
        domain: "focus",
        text: "No tasks yet today — name your top 3 outcomes so the day has direction.",
        action: "add task ",
      },
      learning,
    );
  } else if (signals.tasksDone === 0) {
    pushSuggestion(
      suggestions,
      {
        domain: "focus",
        text: `You have ${signals.tasksTotal} task(s) queued. Knock out the smallest one first to build momentum.`,
      },
      learning,
    );
  } else if (signals.tasksDone < signals.tasksTotal) {
    pushSuggestion(
      suggestions,
      {
        domain: "focus",
        text: `${signals.tasksDone}/${signals.tasksTotal} done — protect a 25-min focus block to clear one more.`,
      },
      learning,
    );
  } else {
    pushSuggestion(
      suggestions,
      {
        domain: "focus",
        text: "All tasks complete. Bank the win and set tomorrow’s top priority tonight.",
      },
      learning,
    );
  }

  // NUTRITION (trainer + dietitian)
  const proteinGap = signals.proteinTarget - signals.proteinCurrent;
  if (proteinGap > 0) {
    pushSuggestion(
      suggestions,
      {
        domain: "nutrition",
        text: `Protein is ${signals.proteinCurrent}g of ${signals.proteinTarget}g — ${proteinGap}g to go. A lean meat, Greek yogurt, or shake closes the gap.`,
        action: "log 40g protein ",
      },
      learning,
    );
  } else {
    pushSuggestion(
      suggestions,
      {
        domain: "nutrition",
        text: `Protein target hit (${signals.proteinCurrent}g). Keep portions steady and prioritize whole foods.`,
      },
      learning,
    );
  }
  if (signals.waterMl < waterTarget) {
    pushSuggestion(
      suggestions,
      {
        domain: "nutrition",
        text: `Hydration at ${waterCurrentOz} fl oz — aim for ~${waterTargetOz} fl oz. Grab a glass now.`,
        action: "add water 12 oz",
      },
      learning,
    );
  }

  // FITNESS
  const w = plannedWorkout ?? fallbackWorkout(signals.dayOfWeek);
  const weeklyTarget = profile.trainingDaysPerWeek ?? 3;
  const injuryNote = profile.injuries?.length
    ? ` Work around your ${profile.injuries.join(" / ")} — swap any movement that aggravates it.`
    : "";
  const fitnessText =
    trend.workouts < weeklyTarget
      ? `${trend.workouts}/${weeklyTarget} workouts this week — today's suggested session: ${w.title} (~${w.estimatedMinutes} min). Schedule it before the day fills up.${injuryNote}`
      : `You've hit ${trend.workouts} workouts this week. Today: ${w.title} (~${w.estimatedMinutes} min) or active recovery if you're sore.${injuryNote}`;
  pushSuggestion(
    suggestions,
    {
      domain: "fitness",
      text: fitnessText,
      action: "add workout " + w.estimatedMinutes + " min",
    },
    learning,
  );

  // FINANCE (advisor)
  if (!signals.hasFinance) {
    pushSuggestion(
      suggestions,
      {
        domain: "finance",
        text: "Add your account balances to start a net-worth baseline — you can’t improve what you don’t measure.",
      },
      learning,
    );
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
    pushSuggestion(
      suggestions,
      {
        domain: "finance",
        text: `Net worth tracked at $${signals.netWorth.toLocaleString()}.${trendNote}${cashflowNote}${savingsNote}`,
      },
      learning,
    );
  }

  // FAMILY / LIFE
  pushSuggestion(
    suggestions,
    {
      domain: "family",
      text: "Block 20 distraction-free minutes with family today — presence compounds more than productivity.",
      action: "add family time 20 min",
    },
    learning,
  );

  // MOMENTUM (trend-aware, general)
  if (trend.activeDays >= 2) {
    const momentum =
      trend.proteinTrend === "down"
        ? `Heads up: protein is trending down this week (avg ${trend.avgProteinPct}% of target). Front-load it at breakfast tomorrow.`
        : trend.taskCompletionPct >= 70
          ? `Strong week — ${trend.taskCompletionPct}% task completion across ${trend.activeDays} active days. Protect what's working.`
          : `You've shown up ${trend.activeDays}/${trend.days} days. Consistency beats intensity — keep the streak alive.`;
    pushSuggestion(suggestions, { domain: "general", text: momentum }, learning);
  }

  // If learning filtered everything, still surface one constructive default.
  if (!suggestions.length) {
    suggestions.push({
      domain: "general",
      text: learning.helpfulTexts[0]
        ? `Double down on what worked recently: ${learning.helpfulTexts[0]}`
        : "Pick one meaningful win and protect a short focus block for it.",
    });
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
  if (profile.coachingStyle) lines.push(`- Coaching style: ${profile.coachingStyle}`);
  if (profile.motivation) lines.push(`- Motivation: ${profile.motivation}`);
  if (profile.lifeContext) lines.push(`- Life context: ${profile.lifeContext}`);
  if (profile.currentFocus) lines.push(`- Current focus: ${profile.currentFocus}`);
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
  if (profile.foodPreferences?.length)
    lines.push(`- Food preferences: ${profile.foodPreferences.join(", ")}`);
  if (profile.skills?.length) {
    lines.push(
      `- Monetizable skills (HIS skills — the ONLY basis for any earn-more or side-income idea): ${profile.skills.join("; ")}`,
    );
  } else {
    lines.push(
      "- Monetizable skills: none listed yet — do NOT invent side-hustle ideas; instead suggest he add his professional skills to his profile so income ideas can be grounded in them",
    );
  }
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
  memories: CoachMemory[],
  learning: RecommendationLearning = emptyLearning(),
): string {
  const name = profile.displayName || "Brian";
  const waterOz = mlToFlOz(signals.waterMl) ?? 0;
  const avgWaterOz = mlToFlOz(trend.avgWaterMl) ?? 0;
  const remembered = memoriesBlock(memories);
  const outcomeLearning = recommendationLearningBlock(learning);
  return `You are ${name}'s personal advisory board: an elite life coach, a certified strength & conditioning coach, and a CFP-level financial advisor whose mandate covers BOTH sides of the ledger: optimizing spending/saving AND growing household income through ${name}'s own monetizable skills (consulting, productized services, and passive/semi-passive income built on what he already knows). Give concise, actionable coaching for TODAY based on real data. Personalize every suggestion to the profile and the 7-day trend — never contradict injuries or dietary restrictions.

User profile:
${profileBlock(profile)}
${remembered ? `\nWhat you remember about the member:\n${remembered}\n` : ""}
${outcomeLearning ? `\nRecent recommendation outcomes (learn from these):\n${outcomeLearning}\n` : ""}

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
- Be specific and encouraging. No fluff, no disclaimers.
- Finance suggestions: alternate between two modes across days — (a) save/optimize using his actual numbers, and (b) EARN MORE. On even weekday indexes use mode (a); on odd weekday indexes use mode (b). Earn-more ideas must be built strictly from the "Monetizable skills" list in the profile: a concrete freelance/consulting offer he could pitch, a productized service, or a passive/semi-passive asset (e.g. a template, tool, course, or retainer built from those skills). Name the skill you're building on. Never suggest a generic side hustle unrelated to his listed skills, and never invent income projections you can't know. No hustle-culture tone.
- Household framing: Brian is the client. His wife is a stay-at-home parent with her hands full raising their kids — her time is NOT spare capacity. Never propose that his wife start a business, sell products, or take on income work. If a suggestion involves her at all, it must be something they choose together, fit inside her existing constraints, and put the execution burden on Brian.
- One earn-more idea at a time, sized as a first step he could take THIS WEEK (e.g. "draft the one-page offer", "list the automation you'd productize"), not a business plan. If a previous earn-more idea already appears in the remembered-member notes above, advance THAT idea to its next step instead of proposing a brand-new one.
- Learn from recent recommendation outcomes: reinforce patterns marked helpful/completed; never re-offer dismissed or not-helpful items; defer snoozed items.`;
}

async function aiCoaching(
  signals: DaySignals,
  profile: UserProfile,
  trend: TrendSignals,
  apiKey: string,
  plannedWorkout: WorkoutSuggestion,
  memories: CoachMemory[],
  learning: RecommendationLearning = emptyLearning(),
): Promise<CoachingResult> {
  const parsed = await completeJSON<any>(apiKey, {
    model: await getGrokJsonModel(),
    messages: [
      {
        role: "system",
        content: "Return strictly valid minified JSON only. No prose.",
      },
      {
        role: "user",
        content: buildCoachPrompt(signals, profile, trend, plannedWorkout, memories, learning),
      },
    ],
    temperature: 0.5,
    maxTokens: 700,
  });

  const workout = plannedWorkout;
  const fbCoaching = fallbackCoaching(signals, profile, trend, plannedWorkout, learning);
  const rawSuggestions: CoachSuggestion[] = Array.isArray(parsed.suggestions)
    ? parsed.suggestions.slice(0, 6).map((s: any) => ({
        domain: (s.domain || "general") as CoachDomain,
        text: String(s.text || "").trim(),
        action: s.action ? String(s.action) : undefined,
      }))
    : fbCoaching.suggestions;
  const suggestions = rawSuggestions.filter(
    (s) => s.text && !isAvoidedRecommendation(s.text, learning),
  );

  return {
    date: signals.date,
    headline: String(parsed.headline || fbCoaching.headline),
    suggestions: suggestions.length ? suggestions : fbCoaching.suggestions,
    workout,
    generatedBy: "ai",
    updatedAt: Date.now(),
  };
}

export async function generateCoachingImpl(data: {
  date?: ISODate;
  force?: boolean;
}): Promise<CoachingResult> {
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

  const [profile, memoriesStore, learning] = await Promise.all([
    loadUserProfileImpl(),
    loadCoachMemoriesImpl(),
    loadRecentRecommendationLearning(date),
  ]);
  const signals = await collectSignals(date, profile);
  const trend = await collectTrend(date, signals.proteinTarget);
  const weeklyWorkout = await getOrCreateWeeklyWorkout(date, profile);

  let result: CoachingResult;
  const apiKey = await getGrokApiKey();
  if (apiKey) {
    try {
      result = await aiCoaching(
        signals,
        profile,
        trend,
        apiKey,
        weeklyWorkout.workout,
        memoriesStore.memories,
        learning,
      );
    } catch (e) {
      console.warn("[coach] Grok coaching failed, using fallback", e);
      result = fallbackCoaching(signals, profile, trend, weeklyWorkout.workout, learning);
    }
  } else {
    result = fallbackCoaching(signals, profile, trend, weeklyWorkout.workout, learning);
  }

  // Persist into the DailyPlan so reloads are free.
  try {
    await saveDailyPlanImpl({
      id: existing?.id || `plan-${date}`,
      createdAt: existing?.createdAt || Date.now(),
      date,
      topTaskIds: existing?.topTaskIds || [],
      workoutPlanId: weeklyWorkout.plan.id,
      nutritionTargets: existing?.nutritionTargets ?? {
        protein: signals.proteinTarget,
      },
      voiceNoteIds: existing?.voiceNoteIds,
      notes: existing?.notes,
      eveningCheckIn: existing?.eveningCheckIn,
      acceptedAt: existing?.acceptedAt,
      acceptedSuggestionIds: existing?.acceptedSuggestionIds,
      dailyQuote: existing?.dailyQuote,
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
}

export async function ensureWeeklyWorkoutPlanImpl(
  date: ISODate = todayISO(),
): Promise<{ plan: WorkoutPlan }> {
  const currentDate = date || todayISO();
  const profile = await loadUserProfileImpl();
  const { plan } = await getOrCreateWeeklyWorkout(currentDate, profile);
  return { plan };
}

export async function acceptDailyCoachingPlanImpl(data: {
  date: ISODate;
  suggestions: CoachSuggestion[];
  workout: WorkoutSuggestion;
}) {
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

  for (const [index, suggestion] of data.suggestions
    .filter((item) => item.text && item.domain !== "general")
    .slice(0, 5)
    .entries()) {
    const task = planTasks[index];
    await recordRecommendationOutcomeImpl({
      id: stableRecommendationId(data.date, "coach-daily", suggestion.text),
      date: data.date,
      source: "coach-daily",
      text: suggestion.text,
      status: "accepted",
      taskId: task.id,
    });
  }

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
    dailyQuote: existingPlan?.dailyQuote,
    voiceNoteIds: existingPlan?.voiceNoteIds,
    eveningCheckIn: existingPlan?.eveningCheckIn,
    notes: existingPlan?.notes,
  });

  return { plan, tasksAdded: [workoutTask, ...planTasks] };
}
function domainLabel(domain: CoachDomain): string {
  return domain.charAt(0).toUpperCase() + domain.slice(1);
}
