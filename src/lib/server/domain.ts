/**
 * Server-side persistence helpers for the Core Domain Model (ADR-002).
 *
 * All reads/writes go through R2 using the key conventions from consolidated ADR-003:
 * - Daily aggregates via getDailyKey(domain, date)
 * - Append-only via getLogKey
 * - Refs via getRefKey
 * - Soft-delete index via recordSoftDelete (meta/deleted/{date}.json shards)
 *
 * Supports soft-delete (deletedAt) uniformly + 7-day hard-delete maintenance.
 *
 * IMPORTANT: Dynamic import of r2 inside handlers to keep server-only.
 */

import { createServerFn } from "@tanstack/react-start";
import type {
  BaseEntity,
  DailyNutrition,
  DailyFinanceSnapshot,
  Transaction,
  DailyPlan,
  WorkoutPlan,
  WorkoutSession,
  ProductivityTask,
  DailyFocusScore,
  WeeklyReview,
  AIInteraction,
  VoiceTranscript,
  VoiceIntent,
  ExerciseLibrary,
  UserProfile,
  ISODate,
  ISOWeek,
} from "@/lib/domain";
import { requireAuthSession } from "@/lib/auth";
import type { SoftDeleteRecord } from "@/server/r2";
import {
  assertSingleActiveWorkoutPlan,
  assertValidMealLog,
  assertValidWorkoutSessionDate,
  resolveVoiceTargetDate,
  legacyTodoFromProductivityTask,
  createProductivityTask,
  createDefaultUserProfile,
  todayISO,
  newId,
  flOzToMl,
  mlToFlOz,
  type Macros,
} from "@/lib/domain";
import { loadTodos, saveTodos } from "@/lib/server/todos";

async function loadR2() {
  const r2 = await import("@/server/r2");
  return r2;
}

function dailyKey(domain: string, date: string, r2: Awaited<ReturnType<typeof loadR2>>) {
  return r2.getDailyKey(date, domain);
}

function refKey(name: string, r2: Awaited<ReturnType<typeof loadR2>>) {
  return r2.getRefKey(name);
}

function logKey(domain: string, date: string | undefined, r2: Awaited<ReturnType<typeof loadR2>>) {
  return r2.getLogKey(domain, date);
}

// deleted index keys accessed directly via the loaded r2 module when needed (getDeletedIndexKey)

// Generic typed get/put for daily aggregates
async function getDaily<T>(domain: string, date: ISODate): Promise<T | null> {
  const r2 = await loadR2();
  return r2.getJSON<T>(dailyKey(domain, date, r2));
}

async function putDaily<T>(domain: string, date: ISODate, value: T): Promise<void> {
  const r2 = await loadR2();
  await r2.putJSON(dailyKey(domain, date, r2), value);
}

// Reference data (exercise library, user prefs, etc)
async function getRef<T>(name: string): Promise<T | null> {
  const r2 = await loadR2();
  return r2.getJSON<T>(refKey(name, r2));
}

async function putRef<T>(name: string, value: T): Promise<void> {
  const r2 = await loadR2();
  await r2.putJSON(refKey(name, r2), value);
}

/* =========================================
   USER PROFILE (personalization, ADR-013)
   Long-lived reference: assistant/brian/user-profile.json
   ========================================= */

export const loadUserProfile = createServerFn({ method: "GET" }).handler(async () => {
  const stored = await getRef<UserProfile>("user-profile.json");
  return stored ?? createDefaultUserProfile();
});

export const saveUserProfile = createServerFn({ method: "POST" })
  .validator((profile: Partial<UserProfile>) => profile)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    const existing = (await getRef<UserProfile>("user-profile.json")) ?? createDefaultUserProfile();
    const now = Date.now();
    // Merge so a partial update never clobbers unrelated fields.
    const next: UserProfile = {
      ...existing,
      ...data,
      id: "user-profile",
      createdAt: existing.createdAt ?? now,
      updatedAt: now,
    };
    await putRef("user-profile.json", next);
    return next;
  });

/* =========================================
   WORKOUT PLAN (single active invariant)
   ========================================= */

/** Stored as reference for simplicity in v1: assistant/brian/workout-plans.json */
export type WorkoutPlansStore = {
  plans: WorkoutPlan[];
  updatedAt: number;
};

export const loadWorkoutPlans = createServerFn({ method: "GET" }).handler(async () => {
  const stored = await getRef<WorkoutPlansStore>("workout-plans.json");
  return stored ?? { plans: [], updatedAt: Date.now() };
});

export const saveWorkoutPlans = createServerFn({ method: "POST" })
  .validator((data: { plans: WorkoutPlan[] }) => data)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    assertSingleActiveWorkoutPlan(data.plans);
    const payload: WorkoutPlansStore = { plans: data.plans, updatedAt: Date.now() };
    await putRef("workout-plans.json", payload);
    return payload;
  });

/* Active plan helper (enforces the invariant at read time too) */
export async function getActiveWorkoutPlan(): Promise<WorkoutPlan | null> {
  const store = await loadWorkoutPlans();
  const active = store.plans.find((p) => p.status === "active" && !p.deletedAt);
  return active ?? null;
}

/* =========================================
   WORKOUT SESSIONS (append or daily list)
   ========================================= */

/** v1: store all sessions under a flat reference (small personal data) */
export type WorkoutSessionsStore = {
  sessions: WorkoutSession[];
  updatedAt: number;
};

export const loadWorkoutSessions = createServerFn({ method: "GET" }).handler(async () => {
  const stored = await getRef<WorkoutSessionsStore>("workout-sessions.json");
  return stored ?? { sessions: [], updatedAt: Date.now() };
});

export const saveWorkoutSessions = createServerFn({ method: "POST" })
  .validator((data: { sessions: WorkoutSession[] }) => data)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    // Validate no future sessions on write
    const now = Date.now();
    data.sessions.forEach((s: WorkoutSession) => {
      if (!s.deletedAt) assertValidWorkoutSessionDate(s.performedAt, now);
    });
    const payload: WorkoutSessionsStore = { sessions: data.sessions, updatedAt: Date.now() };
    await putRef("workout-sessions.json", payload);
    return payload;
  });

/** Append a single completed workout session (quick-log from the dashboard). */
export const appendWorkoutSession = createServerFn({ method: "POST" })
  .validator((session: Omit<WorkoutSession, "id" | "createdAt">) => session)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    const now = Date.now();
    assertValidWorkoutSessionDate(data.performedAt ?? now, now);
    const stored = await getRef<WorkoutSessionsStore>("workout-sessions.json");
    const session: WorkoutSession = {
      id: `session-${now}`,
      createdAt: now,
      ...data,
      performedAt: data.performedAt ?? now,
    };
    const sessions = [...(stored?.sessions || []), session];
    await putRef("workout-sessions.json", { sessions, updatedAt: now });
    return session;
  });

/* =========================================
   DAILY NUTRITION
   ========================================= */

export type DailyNutritionPayload = DailyNutrition & { updatedAt: number };

export const loadDailyNutrition = createServerFn({ method: "GET" })
  .validator((date: ISODate) => date)
  .handler(async ({ data: date }) => {
    const stored = await getDaily<DailyNutritionPayload>("daily-nutrition", date);
    if (stored) return stored;
    // Return empty shell for the day
    return {
      id: `nutrition-${date}`,
      date,
      mealLogs: [],
      totals: { calories: 0, protein: 0, carbs: 0, fat: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies DailyNutritionPayload;
  });

function emptyMacros(): Macros {
  return { calories: 0, protein: 0, carbs: 0, fat: 0 };
}

function addMacros(a: Macros, b: Partial<Macros>): Macros {
  return {
    calories: Math.max(0, Math.round(a.calories + (b.calories ?? 0))),
    protein: Math.max(0, Math.round(a.protein + (b.protein ?? 0))),
    carbs: Math.max(0, Math.round(a.carbs + (b.carbs ?? 0))),
    fat: Math.max(0, Math.round(a.fat + (b.fat ?? 0))),
  };
}

function sumMealMacros(meals: DailyNutrition["mealLogs"]): Macros {
  return meals
    .filter((meal) => !meal.deletedAt)
    .flatMap((meal) => meal.foodItems || [])
    .reduce((total, item) => addMacros(total, item.macros || emptyMacros()), emptyMacros());
}

function estimateMacrosFromText(text: string): {
  macros: Macros;
  confidence: "low" | "medium" | "high";
} {
  const lower = text.toLowerCase();
  const read = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = lower.match(pattern);
      if (match?.[1]) return Number(match[1]);
    }
    return 0;
  };

  const protein = read([
    /(\d+(?:\.\d+)?)\s*g(?:rams?)?\s*(?:of\s*)?protein/,
    /protein\s*(\d+(?:\.\d+)?)\s*g?/,
  ]);
  const carbs = read([
    /(\d+(?:\.\d+)?)\s*g(?:rams?)?\s*(?:of\s*)?carbs?/,
    /carbs?\s*(\d+(?:\.\d+)?)\s*g?/,
  ]);
  const fat = read([/(\d+(?:\.\d+)?)\s*g(?:rams?)?\s*(?:of\s*)?fat/, /fat\s*(\d+(?:\.\d+)?)\s*g?/]);
  const calories = read([
    /(\d+(?:\.\d+)?)\s*(?:cal|cals|calories|kcal)/,
    /(?:cal|cals|calories|kcal)\s*(\d+(?:\.\d+)?)/,
  ]);

  const macroCalories = protein * 4 + carbs * 4 + fat * 9;
  const inferredCalories = calories || macroCalories;
  const knownCount = [protein, carbs, fat, calories].filter((n) => n > 0).length;

  return {
    macros: {
      calories: Math.round(inferredCalories),
      protein: Math.round(protein),
      carbs: Math.round(carbs),
      fat: Math.round(fat),
    },
    confidence: knownCount >= 3 ? "high" : knownCount >= 1 ? "medium" : "low",
  };
}

export const saveDailyNutrition = createServerFn({ method: "POST" })
  .validator(
    (payload: {
      date: ISODate;
      nutrition: Omit<DailyNutrition, "id" | "createdAt" | "updatedAt" | "deletedAt" | "date">;
    }) => payload,
  )
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    // Validate every meal has at least one item
    data.nutrition.mealLogs.forEach(assertValidMealLog);
    const totals = sumMealMacros(data.nutrition.mealLogs);

    const now = Date.now();
    const full: DailyNutritionPayload = {
      id: `nutrition-${data.date}`,
      date: data.date,
      ...(data.nutrition as any),
      totals,
      createdAt: (data.nutrition as any).createdAt ?? now,
      updatedAt: now,
    } as DailyNutritionPayload;

    await putDaily("daily-nutrition", data.date, full);
    return full;
  });

/* =========================================
   DAILY FINANCE SNAPSHOT
   ========================================= */

export type DailyFinancePayload = DailyFinanceSnapshot & { updatedAt: number };

export const loadDailyFinance = createServerFn({ method: "GET" })
  .validator((date: ISODate) => date)
  .handler(async ({ data: date }): Promise<DailyFinancePayload> => {
    const stored = await getDaily<DailyFinancePayload>("daily-finance", date);
    if (stored) return stored;
    return {
      id: `finance-${date}`,
      date,
      netWorth: 0,
      accounts: [],
      positions: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  });

export const saveDailyFinance = createServerFn({ method: "POST" })
  .validator(
    (payload: {
      date: ISODate;
      finance: Omit<
        DailyFinanceSnapshot,
        "id" | "createdAt" | "updatedAt" | "deletedAt" | "netWorth"
      > & {
        netWorth?: number;
      };
    }) => payload,
  )
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    const now = Date.now();
    // Derive net worth from accounts + positions when not explicitly provided.
    const accountsTotal = (data.finance.accounts || []).reduce(
      (s: number, a: { amount?: number }) => s + (a.amount || 0),
      0,
    );
    const positionsTotal = (data.finance.positions || []).reduce(
      (s: number, p: { value?: number }) => s + (p.value || 0),
      0,
    );
    const derivedNetWorth = accountsTotal + positionsTotal;
    const explicitNetWorth =
      typeof data.finance.netWorth === "number" ? data.finance.netWorth : undefined;
    const full: DailyFinancePayload = {
      id: `finance-${data.date}`,
      ...data.finance,
      date: data.date,
      netWorth: explicitNetWorth ?? derivedNetWorth,
      createdAt: (data.finance as any).createdAt ?? now,
      updatedAt: now,
    };
    await putDaily("daily-finance", data.date, full);
    return full;
  });

export type TransactionsStore = {
  transactions: Transaction[];
  updatedAt: number;
};

export const loadTransactions = createServerFn({ method: "GET" }).handler(async () => {
  const stored = await getRef<TransactionsStore>("transactions.json");
  return stored ?? { transactions: [], updatedAt: Date.now() };
});

export const saveTransactions = createServerFn({ method: "POST" })
  .validator((data: { transactions: Transaction[] }) => data)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    const payload: TransactionsStore = {
      transactions: data.transactions,
      updatedAt: Date.now(),
    };
    await putRef("transactions.json", payload);
    return payload;
  });

export const appendTransaction = createServerFn({ method: "POST" })
  .validator((transaction: Omit<Transaction, "id" | "createdAt">) => transaction)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    const now = Date.now();
    const stored = await getRef<TransactionsStore>("transactions.json");
    const transaction: Transaction = {
      id: newId("txn"),
      createdAt: now,
      currency: "USD",
      ...data,
      timestamp: data.timestamp ?? now,
    };
    const transactions = [...(stored?.transactions || []), transaction];
    await putRef("transactions.json", { transactions, updatedAt: now });
    return transaction;
  });

/* =========================================
   PRODUCTIVITY TASKS (unified)
   ========================================= */

/** Daily productivity file: assistant/brian/productivity-tasks/{date}.json */
export type ProductivityTasksPayload = {
  tasks: ProductivityTask[];
  updatedAt: number;
};

export const loadProductivityTasksForDay = createServerFn({ method: "GET" })
  .validator((date: ISODate) => date)
  .handler(async ({ data: date }) => {
    const stored = await getDaily<ProductivityTasksPayload>("productivity-tasks", date);
    return stored ?? { tasks: [], updatedAt: Date.now() };
  });

export const saveProductivityTasksForDay = createServerFn({ method: "POST" })
  .validator((data: { date: ISODate; tasks: ProductivityTask[] }) => data)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    const payload: ProductivityTasksPayload = { tasks: data.tasks, updatedAt: Date.now() };
    await putDaily("productivity-tasks", data.date, payload);
    return payload;
  });

/* =========================================
   DAILY PLAN + FOCUS + WEEKLY REVIEW
   ========================================= */

export type DailyPlanPayload = DailyPlan & { updatedAt: number };

export const loadDailyPlan = createServerFn({ method: "GET" })
  .validator((date: ISODate) => date)
  .handler(async ({ data: date }) => {
    return (await getDaily<DailyPlanPayload>("daily-plan", date)) ?? null;
  });

export const saveDailyPlan = createServerFn({ method: "POST" })
  .validator((plan: DailyPlan) => plan)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    const payload: DailyPlanPayload = { ...data, updatedAt: Date.now() };
    await putDaily("daily-plan", data.date, payload);
    return payload;
  });

export const loadDailyFocusScore = createServerFn({ method: "GET" })
  .validator((date: ISODate) => date)
  .handler(async ({ data: date }) => {
    return await getDaily<DailyFocusScore & { updatedAt: number }>("focus-score", date);
  });

export const saveDailyFocusScore = createServerFn({ method: "POST" })
  .validator((score: DailyFocusScore) => score)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    const payload = { ...data, updatedAt: Date.now() };
    await putDaily("focus-score", data.date, payload);
    return payload;
  });

export const loadWeeklyReview = createServerFn({ method: "GET" })
  .validator((week: ISOWeek) => week)
  .handler(async ({ data: week }) => {
    const r2 = await loadR2();
    return r2.getJSON<WeeklyReview & { updatedAt: number }>(r2.getWeeklyKey(week, "weekly-review"));
  });

export const saveWeeklyReview = createServerFn({ method: "POST" })
  .validator((review: WeeklyReview) => review)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    const r2 = await loadR2();
    const key = r2.getWeeklyKey(data.week, "weekly-review");
    const payload = { ...data, updatedAt: Date.now() };
    await r2.putJSON(key, payload);
    return payload;
  });

/* =========================================
   DAILY DASHBOARD LOADER (ADR-005)
   Unified snapshot + events (jsonl) for current day
   ========================================= */

export interface DailyActivity {
  interactions: AIInteraction[];
  transcripts: VoiceTranscript[];
}

async function parseJsonl<T>(text: string | null): Promise<T[]> {
  if (!text) return [];
  return text
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((x): x is T => !!x);
}

async function loadDayLog<T>(domain: string, date: ISODate): Promise<T[]> {
  const r2 = await loadR2();
  const key = r2.getLogKey(domain, date);
  const text = await r2.getObjectText(key);
  return parseJsonl<T>(text);
}

export type DailyDashboardPayload = {
  date: ISODate;
  nutrition: DailyNutritionPayload | null;
  finance: DailyFinancePayload | null;
  productivity: ProductivityTasksPayload;
  plan: DailyPlanPayload | null;
  focus: (DailyFocusScore & { updatedAt: number }) | null;
  recent: DailyActivity;
};

export const loadDailyDashboard = createServerFn({ method: "GET" })
  .validator((date: ISODate) => date)
  .handler(async ({ data: date }): Promise<DailyDashboardPayload> => {
    const [nutrition, finance, productivity, plan, focus, ai, voice] = await Promise.all([
      loadDailyNutrition({ data: date }),
      loadDailyFinance({ data: date }),
      loadProductivityTasksForDay({ data: date }),
      loadDailyPlan({ data: date }),
      loadDailyFocusScore({ data: date }),
      loadDayLog<AIInteraction>("ai-interactions", date),
      loadDayLog<VoiceTranscript>("voice-transcripts", date),
    ]);

    // Filter logs to the exact calendar date (defensive)
    const dayStart = new Date(date + "T00:00:00").getTime();
    const dayEnd = new Date(date + "T23:59:59.999").getTime();
    const interactions = (ai || []).filter((i) => i.timestamp >= dayStart && i.timestamp <= dayEnd);
    const transcripts = (voice || []).filter(
      (t) => t.timestamp >= dayStart && t.timestamp <= dayEnd,
    );

    return {
      date,
      nutrition: nutrition || null,
      finance: finance || null,
      productivity: productivity || { tasks: [], updatedAt: Date.now() },
      plan: plan || null,
      focus: focus || null,
      recent: { interactions, transcripts },
    };
  });

/* =========================================
   AI + VOICE LOGS (append-only)
   ========================================= */

export const appendAIInteraction = createServerFn({ method: "POST" })
  .validator(
    (interaction: Omit<AIInteraction, "id" | "createdAt" | "updatedAt" | "deletedAt">) =>
      interaction,
  )
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    const r2 = await loadR2();
    const now = Date.now();
    const record: AIInteraction = {
      id: `ai-${now}`,
      createdAt: now,
      ...data,
    } as AIInteraction;
    // Use daily log by default
    const day = new Date(now).toISOString().slice(0, 10);
    const key = logKey("ai-interactions", day, r2);
    await r2.appendLogLine(key, record);
    return record;
  });

export const appendVoiceTranscript = createServerFn({ method: "POST" })
  .validator(
    (transcript: Omit<VoiceTranscript, "id" | "createdAt" | "updatedAt" | "deletedAt">) =>
      transcript,
  )
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    const r2 = await loadR2();
    const now = Date.now();
    const record: VoiceTranscript = {
      id: `voice-${now}`,
      createdAt: now,
      ...data,
    } as VoiceTranscript;
    const day = new Date(now).toISOString().slice(0, 10);
    const key = logKey("voice-transcripts", day, r2);
    await r2.appendLogLine(key, record);
    return record;
  });

/* =========================================
   ADR-004: Voice Interaction Pipeline (STT -> Intent -> Action)
   ========================================= */

/** Lightweight intent used for confirmation + execution. */
export type { VoiceIntent } from "@/lib/domain";

/** Result returned to client after full pipeline run. */
export interface VoiceProcessResult {
  transcriptId: string;
  aiInteractionId: string;
  intent: VoiceIntent;
  spokenText: string;
  success: boolean;
  /** For immediate UI updates on the legacy todo list (compat) */
  legacyTodo?: import("@/lib/todos").Todo;
  /** Error details for failed paths */
  error?: string;
}

/**
 * Minimal-context prompt for Grok to return a single VoiceIntent JSON.
 * Keep tokens low. Output MUST be pure JSON.
 */
function buildIntentPrompt(transcriptText: string, today: ISODate): string {
  return `You are the intent classifier for Brian's personal life-improvement voice assistant.
Today is ${today}.
Interpret the user's spoken words and reply with ONLY one compact JSON object (no markdown, no extra text):

{
  "action": "createTask" | "logWater" | "logMeal" | "deleteTask" | "markTaskDone" | "unknown",
  "payload": { ... relevant fields e.g. {"text":"buy milk","date":"today"} },
  "confidence": 0.0-1.0,
  "requiresConfirmation": boolean,
  "clarificationQuestion": "optional string when action=unknown or confidence low"
}

Rules:
- createTask / logWater / logMeal / markTaskDone : additive or low-risk -> requiresConfirmation=false
- deleteTask or anything destructive/high impact: requiresConfirmation=true
- For createTask payload must include at least "text". Support date "today"|"tomorrow"|YYYY-MM-DD.
- For logWater prefer payload { fluidOunces: number } for US customary phrases, or
  { milliliters: number } if the user explicitly says ml. Infer 8 fl oz if vague "a glass".
- Extract the key request precisely. Do not invent.
- If garbage or ambiguous (confidence < 0.55) set action:"unknown" and provide a short spoken clarificationQuestion.

User said (verbatim):
"""${transcriptText}"""
`;
}

/** Fallback deterministic parser used when no GROK_API_KEY (dev/demo). */
function fallbackParseIntent(text: string, _today: ISODate): VoiceIntent {
  const t = text.toLowerCase().trim();
  // createTask patterns
  const addMatch = t.match(
    /(?:add|create|new|remind me to|todo|task)\s+(?:task\s+)?["']?(.+?)["']?(?:\s+(?:for|on)\s+(today|tomorrow|\d{4}-\d{2}-\d{2}))?$/i,
  );
  if (addMatch || t.startsWith("add ") || t.includes("remind me")) {
    const rawText = (
      addMatch?.[1] || text.replace(/^(add|create|new|remind me to|task)\s*/i, "")
    ).trim();
    const datePart = addMatch?.[2] || (t.includes("tomorrow") ? "tomorrow" : "today");
    const taskText = rawText.replace(/\s+(for|on)\s+(today|tomorrow).*$/i, "").trim() || text;
    return {
      action: "createTask",
      payload: { text: taskText, date: datePart },
      confidence: 0.75,
      requiresConfirmation: false,
    };
  }
  if (t.includes("water") || t.includes("drink")) {
    const waterMatch = t.match(
      /(\d+)\s*(oz|ounce|ounces|fl oz|fluid ounce|fluid ounces|ml|milli|glass|cup)/,
    );
    const unit = waterMatch?.[2] ?? "";
    const amount = waterMatch ? parseInt(waterMatch[1], 10) : 8;
    const ml =
      unit.includes("ml") || unit.includes("milli")
        ? amount
        : unit.includes("cup")
          ? flOzToMl(amount * 8) ?? 237
          : unit.includes("glass")
            ? flOzToMl(amount * 8) ?? 237
            : flOzToMl(amount) ?? 237;
    return {
      action: "logWater",
      payload: { milliliters: ml },
      confidence: 0.8,
      requiresConfirmation: false,
    };
  }
  if (t.includes("delete") || t.includes("remove")) {
    const what = text.replace(/.*?(delete|remove)\s*/i, "").trim() || "item";
    return {
      action: "deleteTask",
      payload: { text: what },
      confidence: 0.65,
      requiresConfirmation: true,
    };
  }
  if (t.includes("done") || t.includes("complete") || t.includes("finish")) {
    const what =
      text.replace(/.*?(mark|set|make)\s+(.+?)\s+(done|complete).*/i, "$2").trim() || text;
    return {
      action: "markTaskDone",
      payload: { text: what },
      confidence: 0.7,
      requiresConfirmation: false,
    };
  }
  return {
    action: "unknown",
    payload: {},
    confidence: 0.3,
    requiresConfirmation: false,
    clarificationQuestion:
      'Sorry, I heard "' + text.slice(0, 60) + '..." — what would you like me to do?',
  };
}

/** Call Grok (xAI OpenAI-compatible) for structured intent. Falls back locally if no key. */
async function extractVoiceIntent(transcriptText: string, today: ISODate): Promise<VoiceIntent> {
  // Access env only on server
  let apiKey: string | undefined;
  try {
    const { env: cfEnv } = await import("cloudflare:workers");
    apiKey = (cfEnv as any)?.GROK_API_KEY;
  } catch {
    // not cf env
  }
  apiKey = apiKey || (globalThis as any).GROK_API_KEY || process?.env?.GROK_API_KEY;

  if (!apiKey) {
    return fallbackParseIntent(transcriptText, today);
  }

  const prompt = buildIntentPrompt(transcriptText, today);
  try {
    const resp = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-3-mini", // or 'grok-3' / 'grok-2-latest'
        messages: [
          { role: "system", content: "Return strictly valid minified JSON only. No prose." },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 400,
      }),
    });
    if (!resp.ok) throw new Error("Grok HTTP " + resp.status);
    const data: any = await resp.json();
    const raw = (data.choices?.[0]?.message?.content || "{}").trim();
    const cleaned = raw.replace(/^```json\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      action: parsed.action || "unknown",
      payload: parsed.payload || {},
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      requiresConfirmation: !!parsed.requiresConfirmation,
      clarificationQuestion: parsed.clarificationQuestion,
    };
  } catch (e) {
    // On any LLM failure, fallback
    console.warn("[voice] Grok intent failed, using fallback", e);
    return fallbackParseIntent(transcriptText, today);
  }
}

/** Execute the intent. Returns spoken confirmation + side effects (writes + legacy compat). */
async function executeVoiceIntent(intent: VoiceIntent): Promise<{
  spokenText: string;
  success: boolean;
  legacyTodo?: import("@/lib/todos").Todo;
  error?: string;
}> {
  const now = Date.now();
  const today = todayISO();

  try {
    switch (intent.action) {
      case "createTask": {
        const text = (intent.payload.text || intent.payload.query || "").toString().trim();
        if (!text) throw new Error("Missing task text");
        const targetDate = resolveVoiceTargetDate(
          intent.payload.date ?? intent.payload.when,
          today,
        );
        const prodTask = createProductivityTask({
          text,
          date: targetDate,
          notes: intent.payload.notes,
          priority: intent.payload.priority,
          source: "ai",
        });
        // Write to new daily aggregate
        const existing = await loadProductivityTasksForDay({ data: targetDate });
        const tasks = [...(existing?.tasks || []), prodTask];
        await saveProductivityTasksForDay({ data: { date: targetDate, tasks } });

        // COMPAT SHIM: also write to legacy todos.json so current UI list updates immediately
        const legacy = legacyTodoFromProductivityTask(prodTask);
        const currentTodos = await loadTodos();
        const items = [...(currentTodos?.items || []), legacy];
        await saveTodos({ data: { items } });

        return {
          spokenText: `Task added: ${text}`,
          success: true,
          legacyTodo: legacy,
        };
      }

      case "logWater": {
        const ml = Number(
          intent.payload.milliliters ?? intent.payload.amountMl ?? intent.payload.ml ?? 250,
        );
        const date = resolveVoiceTargetDate(intent.payload.date, today);
        const nutrition = await loadDailyNutrition({ data: date });
        const currentWater = nutrition.waterMl ?? 0;
        const updated = {
          ...nutrition,
          waterMl: currentWater + Math.max(1, Math.round(ml)),
          updatedAt: now,
        };
        await saveDailyNutrition({ data: { date, nutrition: updated as any } });
        return {
          spokenText: `Logged ${mlToFlOz(ml) ?? Math.round(ml)} fl oz water.`,
          success: true,
        };
      }

      case "logMeal": {
        // Voice macro v1: parse explicitly spoken numbers such as
        // "40g protein chicken" or "600 calorie lunch".
        const desc = (intent.payload.description || intent.payload.text || "meal").toString();
        const date = resolveVoiceTargetDate(intent.payload.date, today);
        const nutrition = await loadDailyNutrition({ data: date });
        const explicitMacros = {
          calories: Number(intent.payload.calories ?? intent.payload.kcal ?? 0),
          protein: Number(intent.payload.protein ?? intent.payload.proteinG ?? 0),
          carbs: Number(intent.payload.carbs ?? intent.payload.carbsG ?? 0),
          fat: Number(intent.payload.fat ?? intent.payload.fatG ?? 0),
        };
        const estimated = estimateMacrosFromText(desc);
        const macros =
          explicitMacros.calories ||
          explicitMacros.protein ||
          explicitMacros.carbs ||
          explicitMacros.fat
            ? addMacros(emptyMacros(), {
                ...explicitMacros,
                calories:
                  explicitMacros.calories ||
                  explicitMacros.protein * 4 + explicitMacros.carbs * 4 + explicitMacros.fat * 9,
              })
            : estimated.macros;
        const mealLog = {
          id: `meal-${now}`,
          timestamp: now,
          foodItems: [
            {
              id: `food-${now}`,
              name: desc,
              quantity: 1,
              unit: "serving",
              macros,
              source: "user" as const,
            },
          ],
          estimateConfidence: estimated.confidence,
          createdAt: now,
        };
        const mealLogs = [...(nutrition.mealLogs || []), mealLog];
        const updated = { ...nutrition, mealLogs, updatedAt: now };
        await saveDailyNutrition({ data: { date, nutrition: updated as any } });
        return { spokenText: `Logged meal: ${desc}`, success: true };
      }

      case "markTaskDone": {
        const matchText = (intent.payload.text || "").toString().toLowerCase();
        const targetDate = resolveVoiceTargetDate(intent.payload.date, today);
        const payload = await loadProductivityTasksForDay({ data: targetDate });
        const updatedTasks = (payload?.tasks || []).map((t: ProductivityTask) =>
          t.text.toLowerCase().includes(matchText) || matchText.includes(t.text.toLowerCase())
            ? { ...t, status: "done" as const, done: true, completedAt: now, updatedAt: now }
            : t,
        );
        await saveProductivityTasksForDay({ data: { date: targetDate, tasks: updatedTasks } });

        // Also try legacy
        const todos = await loadTodos();
        const updatedLegacy = (todos?.items || []).map((t: any) =>
          t.text.toLowerCase().includes(matchText) ? { ...t, done: true, completedAt: now } : t,
        );
        await saveTodos({ data: { items: updatedLegacy } });

        return { spokenText: "Marked task done.", success: true };
      }

      case "deleteTask": {
        // Destructive: caller should have confirmed already
        const matchText = (intent.payload.text || "").toString().toLowerCase();
        const targetDate = resolveVoiceTargetDate(intent.payload.date, today);
        const payload = await loadProductivityTasksForDay({ data: targetDate });
        const filtered = (payload?.tasks || []).filter(
          (t: ProductivityTask) =>
            !(t.text.toLowerCase().includes(matchText) || matchText.includes(t.text.toLowerCase())),
        );
        await saveProductivityTasksForDay({ data: { date: targetDate, tasks: filtered } });

        const todos = await loadTodos();
        const filteredLegacy = (todos?.items || []).filter(
          (t: any) =>
            !(t.text.toLowerCase().includes(matchText) || matchText.includes(t.text.toLowerCase())),
        );
        await saveTodos({ data: { items: filteredLegacy } });

        return { spokenText: "Task deleted.", success: true };
      }

      case "unknown":
      default: {
        const q = intent.clarificationQuestion || "Can you say that again or be more specific?";
        return { spokenText: q, success: false };
      }
    }
  } catch (e: any) {
    return {
      spokenText: "Sorry, I had trouble with that. " + (e?.message || ""),
      success: false,
      error: String(e),
    };
  }
}

/** Main entry for the voice pipeline. Persists transcript + interaction + executes. */
export const processVoiceInput = createServerFn({ method: "POST" })
  .validator((data: { transcriptText: string; language?: string; forceExecute?: boolean }) => data)
  .handler(async (ctx: any): Promise<VoiceProcessResult> => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    const now = Date.now();
    const today = todayISO();
    const text = (data.transcriptText || "").trim();
    if (!text) {
      return {
        transcriptId: "",
        aiInteractionId: "",
        intent: {
          action: "unknown",
          payload: {},
          confidence: 0,
          requiresConfirmation: false,
          clarificationQuestion: "Empty transcript.",
        },
        spokenText: "I did not hear anything.",
        success: false,
        error: "empty",
      };
    }

    // 1. Persist VoiceTranscript (v1: no audio blob yet)
    const r2 = await loadR2();
    const transcriptId = `voice-${now}`;
    const transcript: VoiceTranscript = {
      id: transcriptId,
      createdAt: now,
      timestamp: now,
      audioR2Key: "", // deferred per ADR-004 v1
      transcriptText: text,
      durationSec: Math.max(1, Math.round(text.split(" ").length / 2.5)), // rough
      language: data.language,
    };
    await r2.putVoiceTranscript(transcript);
    // Also append to daily .jsonl for easy per-day reads (dashboard + ADR-005)
    const dayForLog = new Date(now).toISOString().slice(0, 10);
    await r2.appendLogLine(logKey("voice-transcripts", dayForLog, r2), transcript);

    // 2. Extract structured intent (Grok or fallback)
    const intent = await extractVoiceIntent(text, today);

    // 3. Execute ONLY for non-confirm actions, or when forceExecute (user said yes)
    const shouldExecute = data.forceExecute || !intent.requiresConfirmation;
    const exec = shouldExecute
      ? await executeVoiceIntent(intent)
      : {
          spokenText: intent.clarificationQuestion || `About to ${intent.action}. Are you sure?`,
          success: false,
        };

    // 4. Record full AIInteraction (audit)
    const interactionId = `ai-${now}`;
    const interaction: AIInteraction = {
      id: interactionId,
      createdAt: now,
      timestamp: now,
      intent: intent.action,
      prompt: `voice:${text.slice(0, 120)}`,
      response: JSON.stringify({ intent, executed: shouldExecute, result: exec.spokenText }),
      model: "grok-voice-pipeline",
      tokensIn: undefined,
      tokensOut: undefined,
    };
    await r2.putAIInteraction(interaction);
    // Also append to daily .jsonl so dashboard can cheaply load recent activity for date
    await r2.appendLogLine(logKey("ai-interactions", dayForLog, r2), interaction);

    // Link transcript to interaction (best effort update)
    if (!transcript.aiInteractionId) {
      const linked: VoiceTranscript = {
        ...transcript,
        aiInteractionId: interactionId,
        updatedAt: now,
      };
      await r2.putVoiceTranscript(linked);
    }

    return {
      transcriptId,
      aiInteractionId: interactionId,
      intent,
      spokenText: exec.spokenText,
      success: exec.success && shouldExecute,
      legacyTodo: exec.legacyTodo,
      error: exec.error,
    };
  });

/* =========================================
   EXERCISE LIBRARY (long-lived ref)
   ========================================= */

export const loadExerciseLibrary = createServerFn({ method: "GET" }).handler(async () => {
  return await getRef<ExerciseLibrary>("exercise-library.json");
});

export const saveExerciseLibrary = createServerFn({ method: "POST" })
  .validator((lib: ExerciseLibrary) => lib)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    const { data } = ctx;
    await putRef("exercise-library.json", data);
    return data;
  });

/* =========================================
   SOFT DELETE + HARD-DELETE SUPPORT (ADR-003)
   ========================================= */

/**
 * Record that a top-level R2 object (daily aggregate file or ref store) was soft-deleted
 * or contains soft-deleted content. Used to feed the sharded delete index.
 */
export async function recordSoftDeletedKey(
  key: string,
  deletedAt: number = Date.now(),
  domain?: string,
): Promise<void> {
  const r2 = await loadR2();
  await r2.recordSoftDelete(key, deletedAt, domain);
}

/** Mark entity deleted (by id) inside a collection store. Writes back.
 *  Also records the container key in the day's soft-delete index shard (best-effort).
 */
export async function softDeleteInStore<T extends BaseEntity>(
  _storeName: string,
  id: string,
  loadFn: () => Promise<{ items?: T[]; [k: string]: any }>,
  saveFn: (payload: any) => Promise<any>,
  containerKey?: string,
  domainHint?: string,
): Promise<void> {
  const store = await loadFn();
  const items: T[] = (store as any).items ?? (store as any).plans ?? (store as any).sessions ?? [];
  const now = Date.now();
  const updated = items.map((it) =>
    it.id === id ? ({ ...it, deletedAt: now, updatedAt: now } as T) : it,
  );

  // Try common shapes
  let written: any;
  if ((store as any).plans) {
    written = await saveFn({ plans: updated });
  } else if ((store as any).sessions) {
    written = await saveFn({ sessions: updated });
  } else {
    written = await saveFn({ items: updated });
  }

  if (containerKey) {
    await recordSoftDeletedKey(containerKey, now, domainHint);
  }
  return written;
}

/**
 * Hard-delete maintenance (ADR-003).
 * Scans the most recent `days` delete index shards and permanently deletes
 * any objects whose deletedAt is older than 7 days.
 * After processing a shard older than the retention window, the shard itself is removed.
 *
 * Safe to call periodically (e.g. from a scheduled Worker or manually).
 * Returns a summary of actions taken.
 */
export async function runHardDeleteMaintenance(daysBack = 8): Promise<{
  shardsScanned: string[];
  objectsDeleted: string[];
  shardsPruned: string[];
}> {
  const r2 = await loadR2();
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const shardsScanned: string[] = [];
  const objectsDeleted: string[] = [];
  const shardsPruned: string[] = [];

  // Look at today and previous (daysBack-1) days
  for (let i = 0; i < daysBack; i++) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().slice(0, 10);
    const records = await r2.getDeletedIndex(dateStr);
    shardsScanned.push(dateStr);

    const toDelete: SoftDeleteRecord[] = [];
    const keep: SoftDeleteRecord[] = [];

    for (const rec of records) {
      if (now - rec.deletedAt > sevenDaysMs) {
        toDelete.push(rec);
      } else {
        keep.push(rec);
      }
    }

    // Delete the actual objects
    for (const rec of toDelete) {
      try {
        await r2.deleteObject(rec.key);
        objectsDeleted.push(rec.key);
      } catch {
        // ignore individual failures (eventual consistency / already gone)
      }
    }

    // If this shard is fully processed and older than retention, remove the shard file
    const shardIsOld = now - d.getTime() > sevenDaysMs;
    if (shardIsOld && toDelete.length > 0) {
      // We only prune if we had work; keep recent shards even if empty for safety
      try {
        await r2.deleteDeletedIndexShard(dateStr);
        shardsPruned.push(dateStr);
      } catch {
        /* ignore */
      }
    } else if (keep.length !== records.length) {
      // Partial prune inside the shard: rewrite the remaining
      // (only for recent shards we decide to keep)
      if (keep.length === 0 && shardIsOld) {
        await r2.deleteDeletedIndexShard(dateStr);
        shardsPruned.push(dateStr);
      } else {
        // write back kept records (simple put of the filtered list)
        const idxKey = r2.getDeletedIndexKey(dateStr);
        await r2.putJSON(idxKey, keep);
      }
    }
  }

  return { shardsScanned, objectsDeleted, shardsPruned };
}
