import type {
  AIInteraction,
  BaseEntity,
  Budget,
  CategoryGroup,
  DailyFinanceSnapshot,
  DailyFocusScore,
  DailyNutrition,
  DailyPlan,
  ExerciseLibrary,
  ISODate,
  ISOWeek,
  ProductivityTask,
  Subscription,
  Transaction,
  UserProfile,
  VoiceTranscript,
  VoiceIntent,
  WorkoutPlan,
  WorkoutSession,
  WeeklyReview,
} from "@/lib/domain";
import {
  assertSingleActiveWorkoutPlan,
  assertValidMealLog,
  assertValidWorkoutSessionDate,
  createProductivityTask,
  createDefaultUserProfile,
  flOzToMl,
  legacyTodoFromProductivityTask,
  mlToFlOz,
  newId,
  resolveVoiceTargetDate,
  todayISO,
  type Macros,
} from "@/lib/domain";
import { completeJSON, getGrokApiKey } from "@/server/adapters/ai";
import { getDomainStore } from "@/server/store";
import type { SoftDeleteRecord } from "@/server/adapters/r2";
import { loadTodosImpl, saveTodosImpl } from "@/server/todos";

export type WorkoutPlansStore = {
  plans: WorkoutPlan[];
  updatedAt: number;
};

export type WorkoutSessionsStore = {
  sessions: WorkoutSession[];
  updatedAt: number;
};

export type DailyNutritionPayload = DailyNutrition & { updatedAt: number };
export type DailyFinancePayload = DailyFinanceSnapshot & { updatedAt: number };

export type TransactionsStore = {
  transactions: Transaction[];
  updatedAt: number;
};

export type ProductivityTasksPayload = {
  tasks: ProductivityTask[];
  updatedAt: number;
};

export type DailyPlanPayload = DailyPlan & { updatedAt: number };

export interface DailyActivity {
  interactions: AIInteraction[];
  transcripts: VoiceTranscript[];
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

export async function loadUserProfileImpl(): Promise<UserProfile> {
  const store = await getDomainStore();
  const stored = await store.ref.get<UserProfile>("user-profile.json");
  return stored ?? createDefaultUserProfile();
}

export async function saveUserProfileImpl(data: Partial<UserProfile>): Promise<UserProfile> {
  const store = await getDomainStore();
  const existing =
    (await store.ref.get<UserProfile>("user-profile.json")) ?? createDefaultUserProfile();
  const now = Date.now();
  const next: UserProfile = {
    ...existing,
    ...data,
    id: "user-profile",
    createdAt: existing.createdAt ?? now,
    updatedAt: now,
  };
  await store.ref.put("user-profile.json", next);
  return next;
}

export async function loadWorkoutPlansImpl(): Promise<WorkoutPlansStore> {
  const store = await getDomainStore();
  return (
    (await store.ref.get<WorkoutPlansStore>("workout-plans.json")) ?? {
      plans: [],
      updatedAt: Date.now(),
    }
  );
}

export async function saveWorkoutPlansImpl(data: {
  plans: WorkoutPlan[];
}): Promise<WorkoutPlansStore> {
  assertSingleActiveWorkoutPlan(data.plans);
  const payload: WorkoutPlansStore = {
    plans: data.plans,
    updatedAt: Date.now(),
  };
  const store = await getDomainStore();
  await store.ref.put("workout-plans.json", payload);
  return payload;
}

export async function getActiveWorkoutPlanImpl(): Promise<WorkoutPlan | null> {
  const store = await loadWorkoutPlansImpl();
  return store.plans.find((p) => p.status === "active" && !p.deletedAt) ?? null;
}

export async function loadWorkoutSessionsImpl(): Promise<WorkoutSessionsStore> {
  const store = await getDomainStore();
  return (
    (await store.ref.get<WorkoutSessionsStore>("workout-sessions.json")) ?? {
      sessions: [],
      updatedAt: Date.now(),
    }
  );
}

export async function saveWorkoutSessionsImpl(data: {
  sessions: WorkoutSession[];
}): Promise<WorkoutSessionsStore> {
  const now = Date.now();
  data.sessions.forEach((s) => {
    if (!s.deletedAt) assertValidWorkoutSessionDate(s.performedAt, now);
  });
  const payload: WorkoutSessionsStore = {
    sessions: data.sessions,
    updatedAt: now,
  };
  const store = await getDomainStore();
  await store.ref.put("workout-sessions.json", payload);
  return payload;
}

export async function appendWorkoutSessionImpl(
  data: Omit<WorkoutSession, "id" | "createdAt">,
): Promise<WorkoutSession> {
  const now = Date.now();
  assertValidWorkoutSessionDate(data.performedAt ?? now, now);
  const stored = await loadWorkoutSessionsImpl();
  const session: WorkoutSession = {
    id: `session-${now}`,
    createdAt: now,
    ...data,
    performedAt: data.performedAt ?? now,
  };
  await saveWorkoutSessionsImpl({ sessions: [...stored.sessions, session] });
  return session;
}

export function emptyMacros(): Macros {
  return { calories: 0, protein: 0, carbs: 0, fat: 0 };
}

export function addMacros(a: Macros, b: Partial<Macros>): Macros {
  return {
    calories: Math.max(0, Math.round(a.calories + (b.calories ?? 0))),
    protein: Math.max(0, Math.round(a.protein + (b.protein ?? 0))),
    carbs: Math.max(0, Math.round(a.carbs + (b.carbs ?? 0))),
    fat: Math.max(0, Math.round(a.fat + (b.fat ?? 0))),
  };
}

export function sumMealMacros(meals: DailyNutrition["mealLogs"]): Macros {
  return meals
    .filter((meal) => !meal.deletedAt)
    .flatMap((meal) => meal.foodItems || [])
    .reduce((total, item) => addMacros(total, item.macros || emptyMacros()), emptyMacros());
}

export function estimateMacrosFromText(text: string): {
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

export async function loadDailyNutritionImpl(date: ISODate): Promise<DailyNutritionPayload> {
  const store = await getDomainStore();
  const stored = await store.daily.get<DailyNutritionPayload>("daily-nutrition", date);
  if (stored) return stored;
  return {
    id: `nutrition-${date}`,
    date,
    mealLogs: [],
    totals: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export async function saveDailyNutritionImpl(data: {
  date: ISODate;
  nutrition: Omit<DailyNutrition, "id" | "createdAt" | "updatedAt" | "deletedAt" | "date">;
}): Promise<DailyNutritionPayload> {
  data.nutrition.mealLogs.forEach(assertValidMealLog);
  const now = Date.now();
  const full: DailyNutritionPayload = {
    id: `nutrition-${data.date}`,
    date: data.date,
    ...(data.nutrition as any),
    totals: sumMealMacros(data.nutrition.mealLogs),
    createdAt: (data.nutrition as any).createdAt ?? now,
    updatedAt: now,
  };
  const store = await getDomainStore();
  await store.daily.put("daily-nutrition", data.date, full);
  return full;
}

export async function loadDailyFinanceImpl(date: ISODate): Promise<DailyFinancePayload> {
  const store = await getDomainStore();
  const stored = await store.daily.get<DailyFinancePayload>("daily-finance", date);
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
}

export async function saveDailyFinanceImpl(data: {
  date: ISODate;
  finance: Omit<
    DailyFinanceSnapshot,
    "id" | "createdAt" | "updatedAt" | "deletedAt" | "netWorth"
  > & {
    netWorth?: number;
  };
}): Promise<DailyFinancePayload> {
  const now = Date.now();
  const accountsTotal = (data.finance.accounts || []).reduce(
    (s, a: { amount?: number }) => s + (a.amount || 0),
    0,
  );
  const positionsTotal = (data.finance.positions || []).reduce(
    (s, p: { value?: number }) => s + (p.value || 0),
    0,
  );
  const full: DailyFinancePayload = {
    id: `finance-${data.date}`,
    ...data.finance,
    date: data.date,
    netWorth: data.finance.netWorth ?? accountsTotal + positionsTotal,
    createdAt: (data.finance as any).createdAt ?? now,
    updatedAt: now,
  };
  const store = await getDomainStore();
  await store.daily.put("daily-finance", data.date, full);
  return full;
}

export async function loadTransactionsImpl(): Promise<TransactionsStore> {
  const store = await getDomainStore();
  return (
    (await store.ref.get<TransactionsStore>("transactions.json")) ?? {
      transactions: [],
      updatedAt: Date.now(),
    }
  );
}

export async function saveTransactionsImpl(data: {
  transactions: Transaction[];
}): Promise<TransactionsStore> {
  const payload: TransactionsStore = {
    transactions: data.transactions,
    updatedAt: Date.now(),
  };
  const store = await getDomainStore();
  await store.ref.put("transactions.json", payload);
  return payload;
}

export async function appendTransactionImpl(
  data: Omit<Transaction, "id" | "createdAt">,
): Promise<Transaction> {
  const now = Date.now();
  const stored = await loadTransactionsImpl();
  const transaction: Transaction = {
    id: newId("txn"),
    createdAt: now,
    ...data,
    currency: data.currency ?? "USD",
    timestamp: data.timestamp ?? now,
  };
  await saveTransactionsImpl({
    transactions: [...stored.transactions, transaction],
  });
  return transaction;
}

/* ---------- Budget (50/30/20) ---------- */

export type BudgetPayload = Budget & { updatedAt: number };

export async function loadBudgetImpl(): Promise<BudgetPayload | null> {
  const store = await getDomainStore();
  return store.ref.get<BudgetPayload>("budget.json");
}

export async function saveBudgetImpl(data: {
  budget: Omit<Budget, "id" | "createdAt" | "updatedAt" | "deletedAt">;
}): Promise<BudgetPayload> {
  const now = Date.now();
  const existing = await loadBudgetImpl();
  const payload: BudgetPayload = {
    id: "budget",
    ...data.budget,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const store = await getDomainStore();
  await store.ref.put("budget.json", payload);
  return payload;
}

/* ---------- Subscriptions ---------- */

export type SubscriptionsStore = {
  subscriptions: Subscription[];
  updatedAt: number;
};

export async function loadSubscriptionsImpl(): Promise<SubscriptionsStore> {
  const store = await getDomainStore();
  return (
    (await store.ref.get<SubscriptionsStore>("subscriptions.json")) ?? {
      subscriptions: [],
      updatedAt: Date.now(),
    }
  );
}

export async function saveSubscriptionsImpl(data: {
  subscriptions: Subscription[];
}): Promise<SubscriptionsStore> {
  const payload: SubscriptionsStore = {
    subscriptions: data.subscriptions,
    updatedAt: Date.now(),
  };
  const store = await getDomainStore();
  await store.ref.put("subscriptions.json", payload);
  return payload;
}

/* ---------- Category rules (learned overrides) ---------- */

export type CategoryRulesStore = {
  /** Lowercased merchant/keyword → 50/30/20 group. */
  rules: Record<string, CategoryGroup>;
  updatedAt: number;
};

export async function loadCategoryRulesImpl(): Promise<CategoryRulesStore> {
  const store = await getDomainStore();
  return (
    (await store.ref.get<CategoryRulesStore>("category-rules.json")) ?? {
      rules: {},
      updatedAt: Date.now(),
    }
  );
}

export async function saveCategoryRulesImpl(data: {
  rules: Record<string, CategoryGroup>;
}): Promise<CategoryRulesStore> {
  const payload: CategoryRulesStore = {
    rules: data.rules,
    updatedAt: Date.now(),
  };
  const store = await getDomainStore();
  await store.ref.put("category-rules.json", payload);
  return payload;
}

export async function loadProductivityTasksForDayImpl(
  date: ISODate,
): Promise<ProductivityTasksPayload> {
  const store = await getDomainStore();
  return (
    (await store.daily.get<ProductivityTasksPayload>("productivity-tasks", date)) ?? {
      tasks: [],
      updatedAt: Date.now(),
    }
  );
}

export async function saveProductivityTasksForDayImpl(data: {
  date: ISODate;
  tasks: ProductivityTask[];
}): Promise<ProductivityTasksPayload> {
  const payload: ProductivityTasksPayload = {
    tasks: data.tasks,
    updatedAt: Date.now(),
  };
  const store = await getDomainStore();
  await store.daily.put("productivity-tasks", data.date, payload);
  return payload;
}

export async function loadDailyPlanImpl(date: ISODate): Promise<DailyPlanPayload | null> {
  const store = await getDomainStore();
  return store.daily.get<DailyPlanPayload>("daily-plan", date);
}

export async function saveDailyPlanImpl(plan: DailyPlan): Promise<DailyPlanPayload> {
  const payload: DailyPlanPayload = { ...plan, updatedAt: Date.now() };
  const store = await getDomainStore();
  await store.daily.put("daily-plan", plan.date, payload);
  return payload;
}

export async function loadDailyFocusScoreImpl(
  date: ISODate,
): Promise<(DailyFocusScore & { updatedAt: number }) | null> {
  const store = await getDomainStore();
  return store.daily.get<DailyFocusScore & { updatedAt: number }>("focus-score", date);
}

export async function saveDailyFocusScoreImpl(
  score: DailyFocusScore,
): Promise<DailyFocusScore & { updatedAt: number }> {
  const payload = { ...score, updatedAt: Date.now() };
  const store = await getDomainStore();
  await store.daily.put("focus-score", score.date, payload);
  return payload;
}

export async function loadWeeklyReviewImpl(
  week: ISOWeek,
): Promise<(WeeklyReview & { updatedAt: number }) | null> {
  const store = await getDomainStore();
  return store.weekly.get<WeeklyReview & { updatedAt: number }>("weekly-review", week);
}

export async function saveWeeklyReviewImpl(
  review: WeeklyReview,
): Promise<WeeklyReview & { updatedAt: number }> {
  const payload = { ...review, updatedAt: Date.now() };
  const store = await getDomainStore();
  await store.weekly.put("weekly-review", review.week, payload);
  return payload;
}

export async function loadDailyDashboardImpl(date: ISODate): Promise<DailyDashboardPayload> {
  const store = await getDomainStore();
  const [nutrition, finance, productivity, plan, focus, ai, voice] = await Promise.all([
    loadDailyNutritionImpl(date),
    loadDailyFinanceImpl(date),
    loadProductivityTasksForDayImpl(date),
    loadDailyPlanImpl(date),
    loadDailyFocusScoreImpl(date),
    store.log.read<AIInteraction>("ai-interactions", date),
    store.log.read<VoiceTranscript>("voice-transcripts", date),
  ]);
  const dayStart = new Date(date + "T00:00:00").getTime();
  const dayEnd = new Date(date + "T23:59:59.999").getTime();
  return {
    date,
    nutrition,
    finance,
    productivity,
    plan,
    focus,
    recent: {
      interactions: ai.filter((i) => i.timestamp >= dayStart && i.timestamp <= dayEnd),
      transcripts: voice.filter((t) => t.timestamp >= dayStart && t.timestamp <= dayEnd),
    },
  };
}

export async function appendAIInteractionImpl(
  data: Omit<AIInteraction, "id" | "createdAt" | "updatedAt" | "deletedAt">,
): Promise<AIInteraction> {
  const now = Date.now();
  const record: AIInteraction = {
    id: `ai-${now}`,
    createdAt: now,
    ...data,
  } as AIInteraction;
  const day = new Date(now).toISOString().slice(0, 10);
  const store = await getDomainStore();
  await store.log.append("ai-interactions", day, record);
  return record;
}

export async function appendVoiceTranscriptImpl(
  data: Omit<VoiceTranscript, "id" | "createdAt" | "updatedAt" | "deletedAt">,
): Promise<VoiceTranscript> {
  const now = Date.now();
  const record: VoiceTranscript = {
    id: `voice-${now}`,
    createdAt: now,
    ...data,
  } as VoiceTranscript;
  const day = new Date(now).toISOString().slice(0, 10);
  const store = await getDomainStore();
  await store.log.append("voice-transcripts", day, record);
  return record;
}

export interface VoiceProcessResult {
  transcriptId: string;
  aiInteractionId: string;
  intent: VoiceIntent;
  spokenText: string;
  success: boolean;
  legacyTodo?: import("@/lib/todos").Todo;
  error?: string;
}

function buildIntentPrompt(transcriptText: string, today: ISODate): string {
  return `You are the intent parser for Brian's personal life assistant.
Today's date is ${today}.

Return ONLY JSON matching:
{
  "action": "createTask" | "logWater" | "logMeal" | "deleteTask" | "markTaskDone" | "unknown",
  "payload": {},
  "confidence": 0.0-1.0,
  "requiresConfirmation": boolean,
  "clarificationQuestion": "optional"
}

Rules:
- createTask/logWater/logMeal/markTaskDone can execute immediately.
- deleteTask requires confirmation.
- For createTask include { text: string, date?: "today"|"tomorrow"|YYYY-MM-DD }.
- For logMeal include { description: string, date?: ... } and explicit macro fields if spoken.
- For logWater include { fluidOunces: number } for US customary phrases, or
  { milliliters: number } if the user explicitly says ml. Infer 8 fl oz if vague "a glass".
- Extract the key request precisely. Do not invent.
- If garbage or ambiguous (confidence < 0.55) set action:"unknown" and provide a short spoken clarificationQuestion.

User said (verbatim):
"""${transcriptText}"""
`;
}

function fallbackParseIntent(text: string, _today: ISODate): VoiceIntent {
  const t = text.toLowerCase().trim();
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
          ? (flOzToMl(amount * 8) ?? 237)
          : unit.includes("glass")
            ? (flOzToMl(amount * 8) ?? 237)
            : (flOzToMl(amount) ?? 237);
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

async function extractVoiceIntentImpl(
  transcriptText: string,
  today: ISODate,
): Promise<VoiceIntent> {
  const apiKey = await getGrokApiKey();
  if (!apiKey) return fallbackParseIntent(transcriptText, today);

  try {
    const parsed = await completeJSON<any>(apiKey, {
      model: "grok-3-mini",
      messages: [
        {
          role: "system",
          content: "Return strictly valid minified JSON only. No prose.",
        },
        { role: "user", content: buildIntentPrompt(transcriptText, today) },
      ],
      temperature: 0.1,
      maxTokens: 400,
    });
    return {
      action: parsed.action || "unknown",
      payload: parsed.payload || {},
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      requiresConfirmation: !!parsed.requiresConfirmation,
      clarificationQuestion: parsed.clarificationQuestion,
    };
  } catch (e) {
    console.warn("[voice] Grok intent failed, using fallback", e);
    return fallbackParseIntent(transcriptText, today);
  }
}

async function executeVoiceIntentImpl(intent: VoiceIntent): Promise<{
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
        const existing = await loadProductivityTasksForDayImpl(targetDate);
        await saveProductivityTasksForDayImpl({
          date: targetDate,
          tasks: [...(existing?.tasks || []), prodTask],
        });

        const legacy = legacyTodoFromProductivityTask(prodTask);
        const currentTodos = await loadTodosImpl();
        await saveTodosImpl({
          items: [...(currentTodos?.items || []), legacy],
        });

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
        const nutrition = await loadDailyNutritionImpl(date);
        await saveDailyNutritionImpl({
          date,
          nutrition: {
            ...nutrition,
            waterMl: (nutrition.waterMl ?? 0) + Math.max(1, Math.round(ml)),
            updatedAt: now,
          } as any,
        });
        return {
          spokenText: `Logged ${mlToFlOz(ml) ?? Math.round(ml)} fl oz water.`,
          success: true,
        };
      }

      case "logMeal": {
        const desc = (intent.payload.description || intent.payload.text || "meal").toString();
        const date = resolveVoiceTargetDate(intent.payload.date, today);
        const nutrition = await loadDailyNutritionImpl(date);
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
        await saveDailyNutritionImpl({
          date,
          nutrition: {
            ...nutrition,
            mealLogs: [...(nutrition.mealLogs || []), mealLog],
          } as any,
        });
        return { spokenText: `Logged meal: ${desc}`, success: true };
      }

      case "markTaskDone": {
        const matchText = (intent.payload.text || "").toString().toLowerCase();
        const targetDate = resolveVoiceTargetDate(intent.payload.date, today);
        const payload = await loadProductivityTasksForDayImpl(targetDate);
        const updatedTasks = (payload?.tasks || []).map((t) =>
          t.text.toLowerCase().includes(matchText) || matchText.includes(t.text.toLowerCase())
            ? {
                ...t,
                status: "done" as const,
                done: true,
                completedAt: now,
                updatedAt: now,
              }
            : t,
        );
        await saveProductivityTasksForDayImpl({
          date: targetDate,
          tasks: updatedTasks,
        });

        const todos = await loadTodosImpl();
        const updatedLegacy = (todos?.items || []).map((t) =>
          t.text.toLowerCase().includes(matchText) ? { ...t, done: true, completedAt: now } : t,
        );
        await saveTodosImpl({ items: updatedLegacy });
        return { spokenText: "Marked task done.", success: true };
      }

      case "deleteTask": {
        const matchText = (intent.payload.text || "").toString().toLowerCase();
        const targetDate = resolveVoiceTargetDate(intent.payload.date, today);
        const payload = await loadProductivityTasksForDayImpl(targetDate);
        const filtered = (payload?.tasks || []).filter(
          (t) =>
            !(t.text.toLowerCase().includes(matchText) || matchText.includes(t.text.toLowerCase())),
        );
        await saveProductivityTasksForDayImpl({
          date: targetDate,
          tasks: filtered,
        });

        const todos = await loadTodosImpl();
        const filteredLegacy = (todos?.items || []).filter(
          (t) =>
            !(t.text.toLowerCase().includes(matchText) || matchText.includes(t.text.toLowerCase())),
        );
        await saveTodosImpl({ items: filteredLegacy });
        return { spokenText: "Task deleted.", success: true };
      }

      case "unknown":
      default:
        return {
          spokenText: intent.clarificationQuestion || "Can you say that again or be more specific?",
          success: false,
        };
    }
  } catch (e: any) {
    return {
      spokenText: "Sorry, I had trouble with that. " + (e?.message || ""),
      success: false,
      error: String(e),
    };
  }
}

export async function processVoiceInputImpl(data: {
  transcriptText: string;
  language?: string;
  forceExecute?: boolean;
}): Promise<VoiceProcessResult> {
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

  const store = await getDomainStore();
  const transcriptId = `voice-${now}`;
  const transcript: VoiceTranscript = {
    id: transcriptId,
    createdAt: now,
    timestamp: now,
    audioR2Key: "",
    transcriptText: text,
    durationSec: Math.max(1, Math.round(text.split(" ").length / 2.5)),
    language: data.language,
  };
  await store.putVoiceTranscript(transcript);
  const dayForLog = new Date(now).toISOString().slice(0, 10);
  await store.log.append("voice-transcripts", dayForLog, transcript);

  const intent = await extractVoiceIntentImpl(text, today);
  const shouldExecute = data.forceExecute || !intent.requiresConfirmation;
  const exec = shouldExecute
    ? await executeVoiceIntentImpl(intent)
    : {
        spokenText: intent.clarificationQuestion || `About to ${intent.action}. Are you sure?`,
        success: false,
      };

  const interactionId = `ai-${now}`;
  const interaction: AIInteraction = {
    id: interactionId,
    createdAt: now,
    timestamp: now,
    intent: intent.action,
    prompt: `voice:${text.slice(0, 120)}`,
    response: JSON.stringify({
      intent,
      executed: shouldExecute,
      result: exec.spokenText,
    }),
    model: "grok-voice-pipeline",
    tokensIn: undefined,
    tokensOut: undefined,
  };
  await store.putAIInteraction(interaction);
  await store.log.append("ai-interactions", dayForLog, interaction);
  await store.putVoiceTranscript({
    ...transcript,
    aiInteractionId: interactionId,
    updatedAt: now,
  });

  return {
    transcriptId,
    aiInteractionId: interactionId,
    intent,
    spokenText: exec.spokenText,
    success: exec.success && shouldExecute,
    legacyTodo: exec.legacyTodo,
    error: exec.error,
  };
}

export async function loadExerciseLibraryImpl(): Promise<ExerciseLibrary | null> {
  const store = await getDomainStore();
  return store.ref.get<ExerciseLibrary>("exercise-library.json");
}

export async function saveExerciseLibraryImpl(lib: ExerciseLibrary): Promise<ExerciseLibrary> {
  const store = await getDomainStore();
  await store.ref.put("exercise-library.json", lib);
  return lib;
}

export async function recordSoftDeletedKeyImpl(
  key: string,
  deletedAt = Date.now(),
  domain?: string,
): Promise<void> {
  const store = await getDomainStore();
  await store.recordSoftDelete(key, deletedAt, domain);
}

export async function softDeleteInStoreImpl<T extends BaseEntity>(
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
  let written: any;
  if ((store as any).plans) {
    written = await saveFn({ plans: updated });
  } else if ((store as any).sessions) {
    written = await saveFn({ sessions: updated });
  } else {
    written = await saveFn({ items: updated });
  }
  if (containerKey) await recordSoftDeletedKeyImpl(containerKey, now, domainHint);
  return written;
}

export async function runHardDeleteMaintenanceImpl(daysBack = 8): Promise<{
  shardsScanned: string[];
  objectsDeleted: string[];
  shardsPruned: string[];
}> {
  const store = await getDomainStore();
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const shardsScanned: string[] = [];
  const objectsDeleted: string[] = [];
  const shardsPruned: string[] = [];

  for (let i = 0; i < daysBack; i++) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().slice(0, 10);
    const records = await store.getDeletedIndex(dateStr);
    shardsScanned.push(dateStr);

    const toDelete: SoftDeleteRecord[] = [];
    const keep: SoftDeleteRecord[] = [];
    for (const rec of records) {
      if (now - rec.deletedAt > sevenDaysMs) toDelete.push(rec);
      else keep.push(rec);
    }

    for (const rec of toDelete) {
      try {
        await store.deleteObject(rec.key);
        objectsDeleted.push(rec.key);
      } catch {
        /* ignore */
      }
    }

    const shardIsOld = now - d.getTime() > sevenDaysMs;
    if (shardIsOld && toDelete.length > 0) {
      try {
        await store.deleteDeletedIndexShard(dateStr);
        shardsPruned.push(dateStr);
      } catch {
        /* ignore */
      }
    } else if (keep.length !== records.length) {
      if (keep.length === 0 && shardIsOld) {
        await store.deleteDeletedIndexShard(dateStr);
        shardsPruned.push(dateStr);
      } else {
        await store.putJSON(store.getDeletedIndexKey(dateStr), keep);
      }
    }
  }

  return { shardsScanned, objectsDeleted, shardsPruned };
}
